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

// Map to track which blocks have completed streaming
export const completedStreams = new Map<string, boolean>();

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

    let contentChanged = false;
    let significantChange = false;
    let functionCallPattern = false;

    for (const mutation of mutations) {
      if (mutation.type === 'characterData' || mutation.type === 'childList') {
        contentChanged = true;

        // Check if the content contains function call patterns
        const targetNode = mutation.target;
        const textContent = targetNode.textContent || '';

        if (
          textContent.includes('<function_calls>') ||
          textContent.includes('<invoke') ||
          textContent.includes('<parameter') ||
          textContent.includes('</invoke>') ||
          textContent.includes('</function_calls>') ||
          textContent.includes('</parameter>')
        ) {
          functionCallPattern = true;
          significantChange = true;
        }

        // Check for significant size changes in content
        if (mutation.type === 'characterData') {
          const oldValue = mutation.oldValue || '';
          const newValue = targetNode.textContent || '';

          // If content length has changed by more than 10 characters, consider it significant
          if (Math.abs(newValue.length - oldValue.length) > 10) {
            significantChange = true;
          }
        }

        if (mutation.type === 'childList' && (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)) {
          significantChange = true;
        }

        if (significantChange || functionCallPattern) {
          break;
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

      // // Remove stalled status if previously marked
      // if (window._stalledStreams && window._stalledStreams.has(blockId)) {
      //     window._stalledStreams.delete(blockId);
      //     if (window._stalledStreamRetryCount) {
      //         window._stalledStreamRetryCount.delete(blockId);
      //     }
      //     const stalledIndicator = document.querySelector(`.stalled-indicator[data-stalled-for="${blockId}"]`);
      //     if (stalledIndicator) stalledIndicator.remove();
      // }

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

        // Update the queue for rendering
        const targetQueue = window._updateQueue || updateQueue;
        targetQueue.set(blockId, target);

        // Process updates using the global function if available
        if (typeof window !== 'undefined' && window._processUpdateQueue) {
          window._processUpdateQueue();
        }

        // If this is a significant change and the content appears to be complete,
        // mark it for post-streaming re-sync
        if (significantChange && !functionCallPattern) {
          // Check if content appears complete (no open tags)
          const currentContent = node.textContent || '';
          const hasOpenFunctionCallsTag =
            currentContent.includes('<function_calls>') && !currentContent.includes('</function_calls>');
          const hasOpenInvokeTag = currentContent.includes('<invoke') && !currentContent.includes('</invoke>');
          const hasOpenParameterTags =
            (currentContent.match(/<parameter[^>]*>/g) || []).length >
            (currentContent.match(/<\/parameter>/g) || []).length;

          if (!hasOpenFunctionCallsTag && !hasOpenInvokeTag && !hasOpenParameterTags) {
            // Content appears complete, schedule a re-sync
            completedStreams.set(blockId, true);
            setTimeout(() => resyncWithOriginalContent(blockId), 500); // Small delay to ensure rendering is complete
          }
        }
      }
    }
  });

  // Configure the observer to watch the node and its descendants with more detailed options
  observer.observe(node, {
    childList: true,
    characterData: true,
    characterDataOldValue: true, // Track old values for better change detection
    subtree: true,
    attributes: true, // Watch for attribute changes too
    attributeFilter: ['class', 'data-status', 'style'], // Focus on attributes that might signal streaming status
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
 *
 * @param blockId ID of the function block to re-sync
 */
export const resyncWithOriginalContent = (blockId: string): void => {
  if (CONFIG.debug) {
    console.debug(`Re-syncing block ${blockId} with original content`);
  }

  // Find the original pre element
  const originalPre = document.querySelector(`pre[data-block-id="${blockId}"]`);
  if (!originalPre || !originalPre.textContent) {
    if (CONFIG.debug) {
      console.debug(`Original pre element not found for block ${blockId}`);
    }
    return;
  }

  // Find the rendered function block
  const functionBlock = document.querySelector(`.function-block[data-block-id="${blockId}"]`);
  if (!functionBlock) {
    if (CONFIG.debug) {
      console.debug(`Rendered function block not found for block ${blockId}`);
    }
    return;
  }

  // Extract parameters and function name from the original content
  const originalContent = originalPre.textContent.trim();
  const originalParams = extractParameters(originalContent);

  // Extract function name directly
  const invokeMatch = originalContent.match(/<invoke name="([^"]+)"(?:\s+call_id="([^"]+)")?>/);
  const originalFunctionName = invokeMatch && invokeMatch[1] ? invokeMatch[1] : null;

  if (!originalParams.length && !originalFunctionName) {
    if (CONFIG.debug) {
      console.debug(`No parameters or function name found in original content for block ${blockId}`);
    }
    return;
  }

  // Compare and update parameters if needed
  originalParams.forEach(originalParam => {
    const paramId = `${blockId}-${originalParam.name}`;
    const paramValueElement = functionBlock.querySelector(`.param-value[data-param-id="${paramId}"]`);

    if (paramValueElement) {
      const currentContent = paramValueElement.textContent || '';
      const originalContent = originalParam.value;

      // Only update if there's a difference
      if (currentContent !== originalContent) {
        if (CONFIG.debug) {
          console.debug(`Updating parameter ${originalParam.name} with original content`);
          console.debug('Current:', currentContent);
          console.debug('Original:', originalContent);
        }

        // Update the parameter value
        const paramElement = document.createElement('div');
        paramElement.innerHTML = originalContent;

        // Replace content without re-rendering the entire block
        while (paramValueElement.firstChild) {
          paramValueElement.removeChild(paramValueElement.firstChild);
        }

        while (paramElement.firstChild) {
          paramValueElement.appendChild(paramElement.firstChild);
        }
      }
    } else if (CONFIG.debug) {
      console.debug(`Parameter element not found for ${originalParam.name}`);
    }
  });

  // Update function name if needed
  if (originalFunctionName) {
    const functionNameElement = functionBlock.querySelector('.function-name');
    if (functionNameElement && functionNameElement.textContent !== originalFunctionName) {
      if (CONFIG.debug) {
        console.debug(`Updating function name from ${functionNameElement.textContent} to ${originalFunctionName}`);
      }
      functionNameElement.textContent = originalFunctionName;
    }
  }

  // Mark as no longer streaming
  functionBlock.classList.remove('function-loading');

  // Remove streaming attributes from parameters
  const streamingParams = functionBlock.querySelectorAll('[data-streaming="true"]');
  streamingParams.forEach(param => {
    param.removeAttribute('data-streaming');
  });

  // Clean up
  completedStreams.delete(blockId);
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
