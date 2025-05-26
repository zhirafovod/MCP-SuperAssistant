import { CONFIG } from '../core/config';
import { renderFunctionCall } from '../renderer/index';
import { extractParameters } from '../parser/index';

// Declare global window properties for TypeScript
declare global {
  interface Window {
    _isProcessing?: boolean;
    _stalledStreams?: Set<string>;
    _stalledStreamRetryCount?: Map<string, number>;
    _updateQueue?: Map<string, HTMLElement>;
    _processUpdateQueue?: () => void;
  }
}

// Maps to store observers and state for streaming content
export const streamingObservers = new Map<string, MutationObserver>();
export const streamingLastUpdated = new Map<string, number>(); // blockId -> timestamp
export const updateQueue = new Map<string, HTMLElement>(); // Store target elements (pre, code, etc.)

// A flag to indicate if updates are currently being processed
const isProcessing = false;

// Flag to detect abrupt ending of streams
export const abruptlyEndedStreams = new Set<string>();

// Map to track which blocks are currently resyncing to prevent jitter
export const resyncingBlocks = new Set<string>();

// Map to track which blocks have completed streaming
export const completedStreams = new Map<string, boolean>();

// Performance cache for pattern matching
const PATTERN_CACHE = {
  functionCallsStart: /<function_calls>/g,
  functionCallsEnd: /<\/function_calls>/g,
  invokeStart: /<invoke[^>]*>/g,
  invokeEnd: /<\/invoke>/g,
  parameterStart: /<parameter[^>]*>/g,
  parameterEnd: /<\/parameter>/g,
  allFunctionPatterns: /(<function_calls>|<\/function_calls>|<invoke[^>]*>|<\/invoke>|<parameter[^>]*>|<\/parameter>)/g
};

// Fast content analysis cache to avoid repeated parsing
const contentAnalysisCache = new Map<string, {
  hasFunction: boolean;
  isComplete: boolean;
  timestamp: number;
}>();

// Debounced rendering to prevent rapid-fire updates
const renderingDebouncer = new Map<string, number>();
const RENDER_DEBOUNCE_MS = 50; // 50ms debounce for smooth rendering

// Make resyncingBlocks globally accessible to prevent re-rendering during resync
if (typeof window !== 'undefined') {
  (window as any).resyncingBlocks = resyncingBlocks;
}

// Fast chunk detection system for immediate response
const CHUNK_PATTERNS = {
  functionStart: /<function_calls>/,
  invokeStart: /<invoke\s+name="[^"]*"/,
  parameterStart: /<parameter\s+name="[^"]*">/,
  anyClosingTag: /<\/(?:function_calls|invoke|parameter)>/,
  // Pre-compiled for faster detection
  functionChunkStart: /(<function_calls>|<invoke\s+name="[^"]*"|<parameter\s+name="[^"]*">)/,
  significantChunk: /(<function_calls>|<invoke|<parameter|<\/)/
};

// Track parameter content during streaming to prevent loss
const parameterContentCache = new Map<string, Map<string, string>>(); // blockId -> paramName -> content

/**
 * Store parameter content to prevent loss during streaming
 */
const cacheParameterContent = (blockId: string, content: string): void => {
  const params = extractParameters(content);
  if (params.length > 0) {
    const blockCache = parameterContentCache.get(blockId) || new Map();
    
    params.forEach(param => {
      // Only update if new content is longer (more complete)
      const existing = blockCache.get(param.name) || '';
      if (param.value.length > existing.length) {
        blockCache.set(param.name, param.value);
      }
    });
    
    parameterContentCache.set(blockId, blockCache);
    
    if (CONFIG.debug) {
      console.debug(`Cached parameter content for ${blockId}:`, Array.from(blockCache.entries()));
    }
  }
};

/**
 * Get cached parameter content to prevent loss
 */
const getCachedParameterContent = (blockId: string): Map<string, string> => {
  return parameterContentCache.get(blockId) || new Map();
};

/**
 * Ultra-fast chunk detection for immediate streaming response
 */
const detectFunctionChunk = (content: string, previousContent: string = ''): {
  hasNewChunk: boolean;
  chunkType: 'function_start' | 'invoke' | 'parameter' | 'closing' | 'content' | null;
  isSignificant: boolean;
} => {
  // Get only the new content since last check
  const newContent = content.slice(previousContent.length);
  
  if (newContent.length === 0) {
    return { hasNewChunk: false, chunkType: null, isSignificant: false };
  }

  // Fast pattern matching on just the new chunk
  if (CHUNK_PATTERNS.functionStart.test(newContent)) {
    return { hasNewChunk: true, chunkType: 'function_start', isSignificant: true };
  }
  
  if (CHUNK_PATTERNS.invokeStart.test(newContent)) {
    return { hasNewChunk: true, chunkType: 'invoke', isSignificant: true };
  }
  
  if (CHUNK_PATTERNS.parameterStart.test(newContent)) {
    return { hasNewChunk: true, chunkType: 'parameter', isSignificant: true };
  }
  
  if (CHUNK_PATTERNS.anyClosingTag.test(newContent)) {
    return { hasNewChunk: true, chunkType: 'closing', isSignificant: true };
  }
  
  // Check if it's any significant content
  if (CHUNK_PATTERNS.significantChunk.test(newContent) || newContent.length > 20) {
    return { hasNewChunk: true, chunkType: 'content', isSignificant: newContent.length > 20 };
  }

  return { hasNewChunk: false, chunkType: null, isSignificant: false };
};

// Track previous content for chunk detection
const previousContentCache = new Map<string, string>();

/**
 * Immediate chunk processor for instant response
 */
const processChunkImmediate = (blockId: string, newContent: string, chunkInfo: ReturnType<typeof detectFunctionChunk>): void => {
  if (!chunkInfo.hasNewChunk || !chunkInfo.isSignificant) return;

  // Find target element immediately
  const target = document.querySelector(`pre[data-block-id="${blockId}"]`) as HTMLElement;
  if (!target) return;

  // Skip if already processing or complete
  if (completedStreams.has(blockId) || resyncingBlocks.has(blockId)) return;

  if (CONFIG.debug) {
    console.debug(`Immediate chunk detected for ${blockId}: ${chunkInfo.chunkType}, content length: ${newContent.length}`);
  }

  // For parameter content, use longer delays to allow content to accumulate
  let delay = 25; // Default delay
  
  if (chunkInfo.chunkType === 'function_start') {
    delay = 10; // Very fast for function starts
  } else if (chunkInfo.chunkType === 'parameter') {
    delay = 100; // Longer delay for parameters to accumulate content
  } else if (chunkInfo.chunkType === 'content') {
    delay = 150; // Even longer for parameter content
  }

  // Use immediate scheduling with appropriate delay for chunk type
  const timer = setTimeout(() => {
    if (!completedStreams.has(blockId) && !resyncingBlocks.has(blockId)) {
      const targetQueue = window._updateQueue || updateQueue;
      targetQueue.set(blockId, target);

      if (typeof window !== 'undefined' && window._processUpdateQueue) {
        window._processUpdateQueue();
      }
    }
  }, delay);

  // Clear any existing timer and set new one
  const existingTimer = renderingDebouncer.get(blockId);
  if (existingTimer) clearTimeout(existingTimer);
  renderingDebouncer.set(blockId, timer);
};

/**
 * Fast content analysis using pre-compiled patterns and caching
 */
const analyzeFunctionContent = (content: string, useCache: boolean = true): {
  hasFunction: boolean;
  isComplete: boolean;
  functionCallPattern: boolean;
} => {
  if (useCache) {
    const cached = contentAnalysisCache.get(content);
    if (cached && (Date.now() - cached.timestamp) < 1000) { // Cache for 1 second
      return { 
        hasFunction: cached.hasFunction, 
        isComplete: cached.isComplete, 
        functionCallPattern: cached.hasFunction 
      };
    }
  }

  // Reset regex states for accurate matching
  PATTERN_CACHE.functionCallsStart.lastIndex = 0;
  PATTERN_CACHE.functionCallsEnd.lastIndex = 0;
  PATTERN_CACHE.invokeStart.lastIndex = 0;
  PATTERN_CACHE.invokeEnd.lastIndex = 0;
  PATTERN_CACHE.parameterStart.lastIndex = 0;
  PATTERN_CACHE.parameterEnd.lastIndex = 0;

  // Fast pattern detection using pre-compiled regex
  const hasFunctionCalls = PATTERN_CACHE.functionCallsStart.test(content);
  const hasInvoke = PATTERN_CACHE.invokeStart.test(content);
  const hasParameter = PATTERN_CACHE.parameterStart.test(content);
  
  const hasFunction = hasFunctionCalls || hasInvoke || hasParameter;
  
  if (!hasFunction) {
    const result = { hasFunction: false, isComplete: false, functionCallPattern: false };
    if (useCache) {
      contentAnalysisCache.set(content, { ...result, timestamp: Date.now() });
    }
    return result;
  }

  // Check completion using efficient counting
  PATTERN_CACHE.functionCallsStart.lastIndex = 0;
  PATTERN_CACHE.functionCallsEnd.lastIndex = 0;
  PATTERN_CACHE.invokeStart.lastIndex = 0;
  PATTERN_CACHE.invokeEnd.lastIndex = 0;
  PATTERN_CACHE.parameterStart.lastIndex = 0;
  PATTERN_CACHE.parameterEnd.lastIndex = 0;

  const functionCallsOpen = (content.match(PATTERN_CACHE.functionCallsStart) || []).length;
  const functionCallsClosed = (content.match(PATTERN_CACHE.functionCallsEnd) || []).length;
  const invokeOpen = (content.match(PATTERN_CACHE.invokeStart) || []).length;
  const invokeClosed = (content.match(PATTERN_CACHE.invokeEnd) || []).length;
  const parameterOpen = (content.match(PATTERN_CACHE.parameterStart) || []).length;
  const parameterClosed = (content.match(PATTERN_CACHE.parameterEnd) || []).length;

  const isComplete = 
    functionCallsOpen <= functionCallsClosed &&
    invokeOpen <= invokeClosed &&
    parameterOpen <= parameterClosed;

  const result = { hasFunction, isComplete, functionCallPattern: hasFunction };
  
  if (useCache) {
    contentAnalysisCache.set(content, { ...result, timestamp: Date.now() });
  }
  
  return result;
};

/**
 * Optimized debounced rendering to prevent excessive updates
 */
const scheduleOptimizedRender = (blockId: string, target: HTMLElement): void => {
  // Clear any existing debounce timer
  const existingTimer = renderingDebouncer.get(blockId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Schedule new render with debouncing
  const timer = setTimeout(() => {
    renderingDebouncer.delete(blockId);
    
    // Only render if not completed or resyncing
    if (!completedStreams.has(blockId) && !resyncingBlocks.has(blockId)) {
      // Update the queue for rendering
      const targetQueue = window._updateQueue || updateQueue;
      targetQueue.set(blockId, target);

      // Process updates using the global function if available
      if (typeof window !== 'undefined' && window._processUpdateQueue) {
        window._processUpdateQueue();
      }
    }
  }, RENDER_DEBOUNCE_MS);

  renderingDebouncer.set(blockId, timer);
};

/**
 * Monitors a node for changes to detect streaming content updates
 *
 * @param node The HTML element to monitor
 * @param blockId ID of the function block
 */
export const monitorNode = (node: HTMLElement, blockId: string): void => {
  if (streamingObservers.has(blockId)) return;

  if (CONFIG.debug) console.debug(`Setting up direct monitoring for block: ${blockId}`);

  // Initialize the last updated timestamp
  streamingLastUpdated.set(blockId, Date.now());

  // Set an attribute on the node for easier identification
  node.setAttribute('data-monitored-node', blockId);

  // Track consecutive inactive periods (no content changes)
  let inactivePeriods = 0;
  let lastContentLength = node.textContent?.length || 0;
  let detectedIncompleteTags = false;

  // Setup a periodic checker for this node that can detect abrupt endings
  const periodicChecker = setInterval(() => {
    // If node is no longer in the DOM, clean up
    if (!document.body.contains(node)) {
      clearInterval(periodicChecker);
      return;
    }

    const currentContent = node.textContent || '';
    const currentLength = currentContent.length;

    // Check if content has incomplete tags
    const hasOpenFunctionCallsTag =
      currentContent.includes('<function_calls>') && !currentContent.includes('</function_calls>');
    const hasOpenInvokeTag = currentContent.includes('<invoke') && !currentContent.includes('</invoke>');
    const hasOpenParameterTags =
      (currentContent.match(/<parameter[^>]*>/g) || []).length > (currentContent.match(/<\/parameter>/g) || []).length;

    // Detect incomplete tags
    if (hasOpenFunctionCallsTag || hasOpenInvokeTag || hasOpenParameterTags) {
      detectedIncompleteTags = true;
    }

    // If we previously detected incomplete tags, but content hasn't changed in 3 checks,
    // this might be an abruptly ended stream
    if (detectedIncompleteTags && currentLength === lastContentLength) {
      inactivePeriods++;

      if (inactivePeriods >= 3) {
        // This stream has likely ended abruptly
        abruptlyEndedStreams.add(blockId);

        // Signal this as stalled right away instead of waiting for timeout
        const functionBlock = document.querySelector(`.function-block[data-block-id="${blockId}"]`);
        if (functionBlock && functionBlock.classList.contains('function-loading')) {
          // Use our custom event to trigger stalled stream handling
          const event = new CustomEvent('stream-abruptly-ended', {
            detail: { blockId, element: functionBlock },
          });
          document.dispatchEvent(event);

          if (CONFIG.debug) {
            console.debug(`Detected abruptly ended stream for block ${blockId}`);
          }

          // We can clear this interval now
          clearInterval(periodicChecker);
        }
      }
    } else {
      // Reset if content changed
      inactivePeriods = 0;
      lastContentLength = currentLength;
    }
  }, 1000); // Check every second

  const observer = new MutationObserver(mutations => {
    const isProcessingFlag = window._isProcessing !== undefined ? window._isProcessing : isProcessing;
    if (isProcessingFlag) return;

    // Skip if this block is already complete to prevent thrashing
    if (completedStreams.has(blockId)) return;

    let contentChanged = false;
    let significantChange = false;
    let functionCallPattern = false;
    let contentToAnalyze = '';

    // Batch analyze all mutations for better performance
    for (const mutation of mutations) {
      if (mutation.type === 'characterData' || mutation.type === 'childList') {
        contentChanged = true;
        
        // Get the content once for analysis
        const targetNode = mutation.target;
        const textContent = targetNode.textContent || '';
        
        // Use fast pattern matching instead of string includes
        if (!functionCallPattern) {
          PATTERN_CACHE.allFunctionPatterns.lastIndex = 0;
          functionCallPattern = PATTERN_CACHE.allFunctionPatterns.test(textContent);
        }

        // Check for significant size changes in content
        if (mutation.type === 'characterData') {
          const oldValue = mutation.oldValue || '';
          const newValue = textContent;

          // Get previous content for chunk detection
          const previousContent = previousContentCache.get(blockId) || '';
          
          // Use immediate chunk detection for instant response
          const chunkInfo = detectFunctionChunk(newValue, previousContent);
          
          if (chunkInfo.hasNewChunk && chunkInfo.isSignificant) {
            // Cache parameter content as it's being streamed to prevent loss
            cacheParameterContent(blockId, newValue);
            
            // Process chunk immediately for fast response
            processChunkImmediate(blockId, newValue, chunkInfo);
            
            // Update cache for next detection
            previousContentCache.set(blockId, newValue);
            
            significantChange = true;
            contentToAnalyze = newValue;
          } else if (Math.abs(newValue.length - oldValue.length) > 10) {
            // Cache parameter content for any significant content change
            cacheParameterContent(blockId, newValue);
            
            // If content length has changed by more than 10 characters, consider it significant
            significantChange = true;
            contentToAnalyze = newValue;
          }
        }

        if (mutation.type === 'childList' && (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)) {
          significantChange = true;
          contentToAnalyze = textContent;
        }

        if (significantChange && functionCallPattern) {
          break; // Early exit if we have enough info
        }
      }
    }

    if (contentChanged) {
      // Reset the inactive periods counter since we've seen new content
      inactivePeriods = 0;
      lastContentLength = node.textContent?.length || 0;

      // Update the last updated timestamp when content changes
      streamingLastUpdated.set(blockId, Date.now());

      // Remove from abruptly ended if it was previously marked
      if (abruptlyEndedStreams.has(blockId)) {
        abruptlyEndedStreams.delete(blockId);
      }

      // Find the nearest element that contains our monitored node
      let target = node;
      while (target && !CONFIG.targetSelectors.includes(target.tagName.toLowerCase())) {
        target = target.parentElement as HTMLElement;
        if (!target) break;
      }

      if (target) {
        // Log significant changes if debugging is enabled
        if (CONFIG.debug && (significantChange || functionCallPattern)) {
          console.debug(`Significant content change detected in block ${blockId}`, {
            significantChange,
            functionCallPattern,
          });
        }

        // Use optimized scheduling instead of immediate rendering
        if (functionCallPattern || significantChange) {
          scheduleOptimizedRender(blockId, target);
        }

        // Use fast content analysis for completion detection
        if (significantChange && contentToAnalyze) {
          const analysis = analyzeFunctionContent(contentToAnalyze, true);
          
          if (analysis.hasFunction && analysis.isComplete) {
            // Content appears complete - but be more conservative with completion detection
            // Wait a bit longer to ensure all parameter content has been captured
            if (!completedStreams.has(blockId)) {
              // Use a longer delay to ensure all parameter content is captured
              setTimeout(() => {
                // Re-check completion after delay to ensure content is truly complete
                const finalContent = node.textContent || '';
                const finalAnalysis = analyzeFunctionContent(finalContent, false);
                
                if (finalAnalysis.hasFunction && finalAnalysis.isComplete) {
                  completedStreams.set(blockId, true);
                  
                  // Use requestAnimationFrame for smooth completion transition
                  requestAnimationFrame(() => {
                    const functionBlock = document.querySelector(`.function-block[data-block-id="${blockId}"]`);
                    if (functionBlock && functionBlock.classList.contains('function-loading')) {
                      functionBlock.classList.remove('function-loading');
                      functionBlock.classList.add('function-complete');
                      
                      // Remove spinner smoothly
                      const spinner = functionBlock.querySelector('.spinner');
                      if (spinner) {
                        (spinner as HTMLElement).style.transition = 'opacity 0.2s ease';
                        (spinner as HTMLElement).style.opacity = '0';
                        setTimeout(() => spinner.remove(), 200);
                      }
                      
                      // Clean up streaming attributes with minimal delay
                      setTimeout(() => {
                        const streamingParams = functionBlock.querySelectorAll('[data-streaming="true"]');
                        streamingParams.forEach(param => {
                          param.removeAttribute('data-streaming');
                          param.removeAttribute('data-streaming-styled');
                        });
                        
                        const streamingNames = functionBlock.querySelectorAll('.streaming-param-name');
                        streamingNames.forEach(nameEl => {
                          nameEl.classList.remove('streaming-param-name');
                        });
                      }, 50);
                      
                      if (CONFIG.debug) {
                        console.debug(`Marked block ${blockId} as complete using conservative analysis`);
                      }
                    }
                  });
                }
              }, 300); // Longer delay to ensure parameter content is captured
            }
          }
        }
      }
    }
  });

  // Configure the observer to watch the node and its descendants with optimized options
  observer.observe(node, {
    childList: true,
    characterData: true,
    characterDataOldValue: true, // Track old values for better change detection
    subtree: true,
    // Optimize by focusing only on critical attributes that indicate streaming state
    attributes: false, // Disable general attribute watching for performance
    // Only watch specific attributes if needed
    // attributeFilter: ['class', 'data-status'], 
  });

  // Store the observer for later cleanup
  streamingObservers.set(blockId, observer);
};

/**
 * Check for streaming updates in all active blocks
 */
export const checkStreamingUpdates = (): void => {
  if (CONFIG.debug) {
    console.debug('Checking streaming updates...');
  }
  const targetContainers = [];
  for (const selector of CONFIG.streamingContainerSelectors) {
    const containers = document.querySelectorAll<HTMLElement>(selector);
    targetContainers.push(...Array.from(containers));
  }

  // Find all elements in these containers
  for (const container of targetContainers) {
    for (const selector of CONFIG.targetSelectors) {
      const elements = container.querySelectorAll<HTMLElement>(selector);
      for (const element of elements) {
        const blockId = element.getAttribute('data-block-id');
        if (!blockId) continue;

        renderFunctionCall(element as HTMLPreElement, { current: false });
      }
    }
  }
};

/**
 * Start progressive updates for large streaming content
 */
export let progressiveUpdateTimer: ReturnType<typeof setInterval> | null = null;
/**
 * Re-sync the rendered function block with the original pre block content
 * This is a truly seamless update that never removes or replaces DOM elements
 *
 * @param blockId ID of the function block to re-sync
 */
export const resyncWithOriginalContent = (blockId: string): void => {
  if (CONFIG.debug) {
    console.debug(`Starting seamless content resync for block ${blockId}`);
  }

  // Find the original pre element
  const originalPre = document.querySelector(`pre[data-block-id="${blockId}"]`);
  if (!originalPre || !originalPre.textContent) {
    if (CONFIG.debug) {
      console.debug(`Original pre element not found for block ${blockId}`);
    }
    resyncingBlocks.delete(blockId);
    return;
  }

  // Find the rendered function block
  const functionBlock = document.querySelector(`.function-block[data-block-id="${blockId}"]`);
  if (!functionBlock) {
    if (CONFIG.debug) {
      console.debug(`Rendered function block not found for block ${blockId}`);
    }
    resyncingBlocks.delete(blockId);
    return;
  }

  // Extract final parameters from the original content
  const originalContent = originalPre.textContent.trim();
  const originalParams = extractParameters(originalContent);

  // Get cached parameter content to ensure we don't lose any streaming content
  const cachedParams = getCachedParameterContent(blockId);

  // Merge original parameters with cached content (cached takes priority if longer)
  const mergedParams = originalParams.map(param => {
    const cachedContent = cachedParams.get(param.name);
    if (cachedContent && cachedContent.length > param.value.length) {
      if (CONFIG.debug) {
        console.debug(`Using cached content for parameter ${param.name}: ${param.value.length} → ${cachedContent.length} chars`);
      }
      return { ...param, value: cachedContent };
    }
    return param;
  });

  // Extract function name directly
  const invokeMatch = originalContent.match(/<invoke name="([^"]+)"(?:\s+call_id="([^"]+)")?>/);
  const originalFunctionName = invokeMatch && invokeMatch[1] ? invokeMatch[1] : null;

  if (CONFIG.debug) {
    console.debug(`Resync found ${mergedParams.length} parameters and function name: ${originalFunctionName}`);
  }

  // **CRITICAL**: Only update content seamlessly within existing elements
  // NEVER disconnect observers or modify DOM structure

  // Use a single requestAnimationFrame to batch all updates
  requestAnimationFrame(() => {
    // Update function name seamlessly if needed
    if (originalFunctionName) {
      const functionNameElement = functionBlock.querySelector('.function-name-text');
      if (functionNameElement && functionNameElement.textContent !== originalFunctionName) {
        if (CONFIG.debug) {
          console.debug(`Updating function name: ${functionNameElement.textContent} → ${originalFunctionName}`);
        }
        functionNameElement.textContent = originalFunctionName;
      }
    }

    // Update each parameter's content seamlessly
    mergedParams.forEach((param) => {
      const paramId = `${blockId}-${param.name}`;
      const paramValueElement = functionBlock.querySelector(`.param-value[data-param-id="${paramId}"]`);

      if (paramValueElement) {
        const currentContent = paramValueElement.textContent || '';
        const targetContent = param.value;

        // Only update if content actually differs
        if (currentContent !== targetContent) {
          if (CONFIG.debug) {
            console.debug(`Updating parameter ${param.name}: ${currentContent.length} → ${targetContent.length} chars`);
          }

          // Find the actual content container
          const preElement = paramValueElement.querySelector('pre');
          const contentWrapper = paramValueElement.querySelector('.content-wrapper');

          if (preElement) {
            // Update pre element content directly without any visual disruption
            preElement.textContent = targetContent;
          } else if (contentWrapper) {
            // Update content wrapper directly
            contentWrapper.textContent = targetContent;
          } else {
            // Direct update to the parameter element
            paramValueElement.textContent = targetContent;
          }

          // Update the stored value for future comparisons
          paramValueElement.setAttribute('data-current-value', targetContent);
        }
      } else if (CONFIG.debug) {
        console.debug(`Parameter element not found for ${param.name} (this is normal during streaming)`);
      }
    });

    // Smoothly transition out of streaming state
    const wasLoading = functionBlock.classList.contains('function-loading');
    if (wasLoading) {
      if (CONFIG.debug) {
        console.debug(`Transitioning block ${blockId} from loading to complete state`);
      }
      
      // Remove loading state smoothly
      functionBlock.classList.remove('function-loading');
      functionBlock.classList.add('function-complete');
      
      // Remove spinner if it exists
      const spinner = functionBlock.querySelector('.spinner');
      if (spinner) {
        (spinner as HTMLElement).style.opacity = '0';
        (spinner as HTMLElement).style.transition = 'opacity 0.3s ease';
        setTimeout(() => {
          if (spinner.parentNode) {
            spinner.parentNode.removeChild(spinner);
          }
        }, 300);
      }
    }

    // Remove streaming attributes gradually
    const streamingParams = functionBlock.querySelectorAll('[data-streaming="true"]');
    streamingParams.forEach((param, index) => {
      setTimeout(() => {
        param.removeAttribute('data-streaming');
        param.removeAttribute('data-streaming-styled');
        
        // Reset visual properties
        const paramElement = param as HTMLElement;
        paramElement.style.willChange = 'auto';
        paramElement.style.containIntrinsicSize = 'auto';
      }, index * 20); // Very fast staggered removal
    });

    // Remove streaming visual classes
    const streamingNames = functionBlock.querySelectorAll('.streaming-param-name');
    streamingNames.forEach((nameEl, index) => {
      setTimeout(() => {
        nameEl.classList.remove('streaming-param-name');
      }, index * 20);
    });

    // Final cleanup after a short delay
    setTimeout(() => {
      completedStreams.delete(blockId);
      resyncingBlocks.delete(blockId);
      
      // Clean up parameter content cache to free memory
      parameterContentCache.delete(blockId);
      
      // **IMPORTANT**: DO NOT disconnect or delete the observer
      // Let it continue monitoring for any future changes
      
      if (CONFIG.debug) {
        console.debug(`Completed seamless resync for block ${blockId}`);
      }
    }, Math.max(streamingParams.length * 20, 100));
  });
};

/**
 * Start progressive updates for large streaming content
 */
export const startProgressiveUpdates = (): void => {
  if (progressiveUpdateTimer) {
    clearInterval(progressiveUpdateTimer);
  }

  progressiveUpdateTimer = setInterval(() => {
    if (!document.body.contains(document.querySelector('.large-content'))) {
      // No more large content visible, stop the timer
      clearInterval(progressiveUpdateTimer!);
      progressiveUpdateTimer = null;
      return;
    }

    checkStreamingUpdates();
  }, CONFIG.progressiveUpdateInterval);
};
