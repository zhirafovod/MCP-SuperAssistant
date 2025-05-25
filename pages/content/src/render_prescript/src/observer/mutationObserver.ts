import { CONFIG } from '../core/config';
import { debounce } from '../utils/index';
import { renderFunctionCall, renderedFunctionBlocks, processedElements } from '../renderer/index';
import { stabilizeBlock, unstabilizeBlock } from '../renderer/components';
import {
  monitorNode,
  streamingObservers,
  updateQueue,
  streamingLastUpdated,
  startProgressiveUpdates,
} from './streamObserver';
import type { StabilizedBlock } from '../core/types';
import { streamingContentLengths } from '../parser/index';
import {
  preExistingIncompleteBlocks,
  startStalledStreamDetection,
  stopStalledStreamDetection,
} from './stalledStreamHandler';

// Performance optimization: Cache DOM queries and element checks
const elementCache = new WeakMap<Element, { isTarget: boolean; hasContent: boolean; lastCheck: number }>();
const CACHE_DURATION = 5000; // 5 seconds cache validity

// Throttling for high-frequency mutations
let mutationThrottle: ReturnType<typeof setTimeout> | null = null;
const MUTATION_THROTTLE_MS = 16; // ~60fps

// Pre-compiled regex patterns for better performance
const FUNCTION_PATTERNS = [
  /<function_calls>/i,
  /<\/function_calls>/i,
  /<invoke\s+name=/i,
  /<\/invoke>/i,
  /<tool_call/i,
  /<\/tool_call>/i,
  /<parameter\s+name=/i,
  /<\/parameter>/i
];

// Compiled selector cache
let targetSelectorsCompiled: string | null = null;
let streamingSelectorsCompiled: string | null = null;

// State for processing and observers
let isProcessing = false;
let functionCallObserver: MutationObserver | null = null;
let updateThrottleTimer: ReturnType<typeof setTimeout> | null = null;
let mutationProcessingTimer: ReturnType<typeof setTimeout> | null = null;

// Extend window type
declare global {
  interface Window {
    _isProcessing?: boolean;
    _updateQueue?: Map<string, HTMLElement>;
    _stalledStreams?: Set<string>;
    _stalledStreamRetryCount?: Map<string, number>;
    _processUpdateQueue?: () => void;
    preExistingIncompleteBlocks?: Set<string>;
  }
}

/**
 * Optimized helper functions for better performance
 */

/**
 * Fast check if element is a target using compiled selectors
 */
const isTargetElement = (element: Element): boolean => {
  const now = Date.now();
  const cached = elementCache.get(element);
  
  if (cached && (now - cached.lastCheck) < CACHE_DURATION) {
    return cached.isTarget;
  }
  
  if (!targetSelectorsCompiled) {
    targetSelectorsCompiled = CONFIG.targetSelectors.join(',');
  }
  
  const isTarget = element.matches(targetSelectorsCompiled);
  elementCache.set(element, { isTarget, hasContent: false, lastCheck: now });
  
  return isTarget;
};

/**
 * Fast check if element contains target elements
 */
const hasTargetElements = (element: Element): boolean => {
  if (!targetSelectorsCompiled) {
    targetSelectorsCompiled = CONFIG.targetSelectors.join(',');
  }
  return element.querySelectorAll(targetSelectorsCompiled).length > 0;
};

/**
 * Fast check if element is a streaming container
 */
const isStreamingContainer = (element: Element): boolean => {
  if (!streamingSelectorsCompiled) {
    streamingSelectorsCompiled = CONFIG.streamingContainerSelectors.join(',');
  }
  return element.matches(streamingSelectorsCompiled);
};

/**
 * Fast check if element has streaming containers
 */
const hasStreamingContainers = (element: Element): boolean => {
  if (!streamingSelectorsCompiled) {
    streamingSelectorsCompiled = CONFIG.streamingContainerSelectors.join(',');
  }
  return element.querySelectorAll(streamingSelectorsCompiled).length > 0;
};

/**
 * Optimized pattern matching for function calls using pre-compiled regex
 */
const hasRelevantContent = (element: Element): boolean => {
  const now = Date.now();
  const cached = elementCache.get(element);
  
  if (cached && (now - cached.lastCheck) < CACHE_DURATION) {
    return cached.hasContent;
  }
  
  const textContent = element.textContent || '';
  if (!textContent) {
    elementCache.set(element, { isTarget: false, hasContent: false, lastCheck: now });
    return false;
  }
  
  // Use pre-compiled patterns for faster matching
  const hasContent = FUNCTION_PATTERNS.some(pattern => pattern.test(textContent));
  
  const existingCache = elementCache.get(element) || { isTarget: false, hasContent: false, lastCheck: 0 };
  elementCache.set(element, { ...existingCache, hasContent, lastCheck: now });
  
  return hasContent;
};

/**
 * Fast text content pattern matching
 */
const hasRelevantTextContent = (textContent: string): boolean => {
  if (!textContent) return false;
  
  // Use pre-compiled patterns for better performance
  return FUNCTION_PATTERNS.some(pattern => pattern.test(textContent));
};

/**
 * Process batched mutations for better performance
 */
let mutationBatch: MutationRecord[] = [];
const processMutationBatch = (handleDomChanges: () => void): void => {
  if (mutationBatch.length === 0) return;
  
  let shouldProcess = false;
  const relevantChanges = new Set<Element>();
  
  // Process all mutations in the batch
  for (const mutation of mutationBatch) {
    if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const element = node as Element;
          
          // Quick checks for relevance using optimized functions
          if (isTargetElement(element) || hasTargetElements(element) || 
              isStreamingContainer(element) || hasStreamingContainers(element) || 
              hasRelevantContent(element)) {
            relevantChanges.add(element);
            shouldProcess = true;
          }
        }
      }
    } else if (mutation.type === 'characterData') {
      // Check if the text change might be adding function call content
      const textContent = mutation.target.textContent || '';
      if (hasRelevantTextContent(textContent)) {
        const parentElement = mutation.target.parentElement;
        if (parentElement) {
          relevantChanges.add(parentElement);
          shouldProcess = true;
        }
      }
    }
  }

  if (shouldProcess) {
    if (CONFIG.debug && relevantChanges.size > 0) {
      console.debug(`Processing ${relevantChanges.size} relevant changes from ${mutationBatch.length} mutations`);
    }
    
    handleDomChanges();
  }
};

/**
 * Process queued updates with stabilization for smoothness
 */
export const processUpdateQueue = (): void => {
  const validUpdates = new Map<string, HTMLElement>();
  updateQueue.forEach((node, blockId) => {
    if (document.body.contains(node)) {
      validUpdates.set(blockId, node);
      // Update the last updated timestamp
      streamingLastUpdated.set(blockId, Date.now());
      // If previously marked as stalled, remove that marker
      if (window._stalledStreams && window._stalledStreams.has(blockId)) {
        window._stalledStreams.delete(blockId);
        const stalledIndicator = document.querySelector(`.stalled-indicator[data-stalled-for="${blockId}"]`);
        if (stalledIndicator) stalledIndicator.remove();
      }
    } else {
      if (CONFIG.debug) console.debug(`Node for block ${blockId} removed, skipping update and cleaning up.`);
      const observer = streamingObservers.get(blockId);
      if (observer) {
        observer.disconnect();
        streamingObservers.delete(blockId);
      }
      renderedFunctionBlocks.delete(blockId);
      streamingLastUpdated.delete(blockId);
      if (window._stalledStreams) window._stalledStreams.delete(blockId);
      // Clean up keys starting with blockId- from streamingContentLengths
      Array.from(streamingContentLengths.keys())
        .filter(key => key.startsWith(`${blockId}-`))
        .forEach(key => streamingContentLengths.delete(key));
    }
  });

  if (validUpdates.size === 0) {
    updateQueue.clear();
    if (isProcessing) {
      isProcessing = false;
      window._isProcessing = false;
    }
    return;
  }

  updateQueue.clear();
  validUpdates.forEach((node, blockId) => updateQueue.set(blockId, node));

  if (isProcessing) return;
  isProcessing = true;
  window._isProcessing = true;

  const stabilizedBlocks = new Map<string, StabilizedBlock>();

  try {
    // if (CONFIG.usePositionFixed) {
    //     updateQueue.forEach((node, blockId) => {
    //         const stabilized = stabilizeBlock(blockId);
    //         if (stabilized) {
    //             stabilizedBlocks.set(blockId, stabilized);
    //         }
    //     });
    // }

    updateQueue.forEach((node, blockId) => {
      if (CONFIG.debug) console.debug(`Processing update for block: ${blockId}`);
      renderFunctionCall(node as HTMLPreElement, { current: isProcessing });
    });

    updateQueue.clear();

    const hasLargeStreaming = Array.from(streamingContentLengths.values()).some(
      length => length > CONFIG.largeContentThreshold,
    );

    if (hasLargeStreaming) {
      startProgressiveUpdates();
    }
  } catch (e) {
    console.error('Error processing update queue:', e);
  } finally {
    // if (stabilizedBlocks.size > 0) {
    //     setTimeout(() => {
    //         stabilizedBlocks.forEach((stabilized) => {
    //             unstabilizeBlock(stabilized);
    //         });
    //     }, CONFIG.stabilizeTimeout);
    // }
    isProcessing = false;
    window._isProcessing = false;
  }
};

// Expose shared state to window
if (typeof window !== 'undefined') {
  window._isProcessing = isProcessing;
  window._updateQueue = updateQueue;
  window._stalledStreams = window._stalledStreams || new Set<string>();
  window._stalledStreamRetryCount = window._stalledStreamRetryCount || new Map<string, number>();
  window.preExistingIncompleteBlocks = preExistingIncompleteBlocks;
  window._processUpdateQueue = processUpdateQueue;
}

/**
 * Process all function calls in the document
 */
export const processFunctionCalls = (): number => {
  const processedCount = checkForUnprocessedFunctionCalls();
  return processedCount;
};

/**
 * Check for unprocessed function calls in the document with improved efficiency
 */
export const checkForUnprocessedFunctionCalls = (): number => {
  let processedCount = 0;

  // Use a more efficient approach to get target elements
  const getTargetElements = (): HTMLElement[] => {
    // Use a single querySelectorAll with combined selectors for better performance
    const combinedSelector = CONFIG.targetSelectors.join(',');
    return Array.from(document.querySelectorAll<HTMLElement>(combinedSelector));
  };

  // Process each target element with early filtering
  const elements = getTargetElements();
  
  for (const element of elements) {
    // Skip if already processed or is part of a function block
    if (processedElements.has(element) || element.closest('.function-block')) {
      continue;
    }
    
    // Quick content check to see if it might contain function calls or XML
    const textContent = element.textContent || '';
    if (!hasRelevantTextContent(textContent) && !textContent.includes('<')) {
      continue;
    }

    // Generate or get block ID
    const blockId = element.getAttribute('data-block-id') || 
      `block-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    
    // Set block ID if not present
    if (!element.getAttribute('data-block-id')) {
      element.setAttribute('data-block-id', blockId);
    }

    const result = renderFunctionCall(element as HTMLPreElement, { current: false });
    if (result) {
      processedCount++;
      // Track this element for streaming updates
      monitorNode(element, blockId);
    }
  }

  return processedCount;
};

/**
 * Start direct monitoring of content for function calls
 */
export const startDirectMonitoring = (): void => {
  if (!CONFIG.enableDirectMonitoring) return;

  // Start with a clean slate
  stopDirectMonitoring();

  // Process any existing function calls
  processFunctionCalls();

  // Set up stalled stream detection
  startStalledStreamDetection();

  // Define a function to observe DOM changes and process new function calls
  const handleDomChanges = debounce(() => {
    if (!isProcessing) {
      const processedCount = checkForUnprocessedFunctionCalls();
      if (processedCount > 0 && CONFIG.debug) {
        console.debug(`Processed ${processedCount} new function blocks`);
      }
    }
  }, CONFIG.updateThrottle);

  // Create a mutation observer to watch for changes to the DOM
  functionCallObserver = new MutationObserver(mutations => {
    // Batch mutations for better performance
    mutationBatch.push(...mutations);
    
    // Clear previous timer
    if (mutationProcessingTimer) {
      clearTimeout(mutationProcessingTimer);
    }
    
    // Process mutations in batches with a short delay
    mutationProcessingTimer = setTimeout(() => {
      processMutationBatch(handleDomChanges);
      mutationBatch = [];
      mutationProcessingTimer = null;
    }, MUTATION_THROTTLE_MS);
  });

  // Configure the observer to watch for changes to the document
  functionCallObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true, // Also watch for text content changes
    characterDataOldValue: true, // Keep old values for comparison
  });

  if (CONFIG.debug) console.debug('Direct monitoring started for function calls');
};

/**
 * Stop direct monitoring of content for function calls
 */
export const stopDirectMonitoring = (): void => {
  // Disconnect the main mutation observer
  if (functionCallObserver) {
    functionCallObserver.disconnect();
    functionCallObserver = null;
  }

  // Clear mutation processing timer
  if (mutationProcessingTimer) {
    clearTimeout(mutationProcessingTimer);
    mutationProcessingTimer = null;
  }

  // Clear mutation batch
  mutationBatch = [];

  // Disconnect all streaming observers
  streamingObservers.forEach(observer => observer.disconnect());
  streamingObservers.clear();

  // Clear the streaming update timer
  if (updateThrottleTimer) {
    clearTimeout(updateThrottleTimer);
    updateThrottleTimer = null;
  }

  // Stop stalled stream detection
  stopStalledStreamDetection();

  if (CONFIG.debug) console.debug('Enhanced direct monitoring stopped for function calls');
};

/**
 * Initialize the observer for function calls
 */
export const initializeObserver = (): void => {
  if (CONFIG.enableDirectMonitoring) {
    startDirectMonitoring();
  }
};

/**
 * Debug and monitoring functions for enhanced observability
 */

/**
 * Force check and process function calls manually - useful for debugging
 */
export const forceProcessFunctionCalls = (): number => {
  console.debug('Force processing function calls...');
  
  // Clear cache to ensure fresh detection
  elementCache.delete as any; // Clear all cache entries
  targetSelectorsCompiled = null;
  streamingSelectorsCompiled = null;
  
  // Force process without checking processed elements
  const processedCount = checkForUnprocessedFunctionCalls();
  
  console.debug(`Force processed ${processedCount} function calls`);
  return processedCount;
};

/**
 * Get performance statistics
 */
export const getPerformanceStats = () => {
  return {
    cacheEntries: 'WeakMap (no size available)',
    isProcessing,
    hasObserver: !!functionCallObserver,
    mutationBatchSize: mutationBatch.length,
    renderedBlocksCount: renderedFunctionBlocks.size,
    processedElementsCount: 'WeakSet (no size available)',
    streamingObserversCount: streamingObservers.size,
    hasMutationTimer: !!mutationProcessingTimer,
    hasUpdateTimer: !!updateThrottleTimer,
  };
};

/**
 * Expose debugging functions to window object for manual testing
 */
if (typeof window !== 'undefined' && CONFIG.debug) {
  (window as any).debugFunctionObserver = {
    forceProcess: forceProcessFunctionCalls,
    getStats: getPerformanceStats,
    startMonitoring: startDirectMonitoring,
    stopMonitoring: stopDirectMonitoring,
    processFunctionCalls,
    checkUnprocessed: checkForUnprocessedFunctionCalls,
  };
}
