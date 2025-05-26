import { CONFIG } from '../core/config';
import { containsFunctionCalls, extractLanguageTag } from '../parser/index';
import { safelySetContent } from '../utils/index';
import {
  addRawXmlToggle,
  addExecuteButton,
  setupAutoScroll,
  smoothlyUpdateBlockContent,
  extractFunctionParameters,
} from './components';
import { applyThemeClass } from '../utils/themeDetector';
import { getPreviousExecution, getPreviousExecutionLegacy, generateContentSignature } from '../mcpexecute/storage';
import type { ParamValueElement } from '../core/types';

// Define custom property for tracking scroll state
declare global {
  interface HTMLElement {
    _userHasScrolled?: boolean;
  }
}

// Performance optimizations: Pre-compiled regex patterns
const REGEX_CACHE = {
  paramStartRegex: /<parameter\s+name="([^"]+)"[^>]*>/gs,
  invokeMatch: /<invoke name="([^"]+)"(?:\s+call_id="([^"]+)")?>/i,
  cdataMatch: /<!\[CDATA\[(.*?)(?:\]\]>)?$/s,
  endParameterTag: '</parameter>'
} as const;

// Performance: Content parsing cache
const contentParsingCache = new WeakMap<HTMLElement, {
  content: string;
  functionName: string;
  callId: string;
  parameters: Record<string, string>;
  lastHash: string;
}>();

// Performance: Element cache for DOM queries
const elementQueryCache = new WeakMap<HTMLElement, {
  functionNameElement?: HTMLDivElement;
  paramsContainer?: HTMLDivElement;
  buttonContainer?: HTMLDivElement;
  lastCacheTime: number;
}>();

// Performance: Batch DOM operations
const pendingDOMUpdates = new Map<string, (() => void)[]>();
let rafScheduled = false;

// Performance: Optimized timeout management
const activeTimeouts = new Map<string, number>();

// Monaco editor CSP-compatible configuration
const configureMonacoEditorForCSP = () => {
  if (typeof window !== 'undefined' && (window as any).monaco) {
    try {
      // Override worker creation to disable web workers
      // This is not ideal for performance but allows Monaco to work in strict CSP environments
      (window as any).monaco.editor.onDidCreateEditor((editor: any) => {
        // Disable worker-based features
        editor.updateOptions({
          wordBasedSuggestions: false,
          snippetSuggestions: false,
          suggestOnTriggerCharacters: false,
          semanticHighlighting: { enabled: false },
          codeLens: false,
          formatOnType: false,
          folding: false,
        });
      });

      // Override Monaco environment worker URL generation
      (window as any).MonacoEnvironment = {
        getWorkerUrl: function () {
          // Return a script that defines a no-op worker
          return 'data:text/javascript;charset=utf-8,console.debug("Monaco worker disabled for CSP compatibility");';
        },
      };

      console.debug('Monaco editor configured for CSP compatibility');
    } catch (e) {
      console.error('Failed to configure Monaco editor for CSP:', e);
    }
  }
};

// State management for rendered elements
export const processedElements = new WeakSet<HTMLElement>();
export const renderedFunctionBlocks = new Map<string, HTMLDivElement>();

// Performance: Fast content hash generation for change detection
const generateContentHash = (content: string): string => {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
};

// Performance: Batch DOM operations using RAF
const batchDOMOperation = (blockId: string, operation: () => void): void => {
  if (!pendingDOMUpdates.has(blockId)) {
    pendingDOMUpdates.set(blockId, []);
  }
  pendingDOMUpdates.get(blockId)!.push(operation);
  
  if (!rafScheduled) {
    rafScheduled = true;
    requestAnimationFrame(() => {
      pendingDOMUpdates.forEach((operations) => {
        operations.forEach(op => op());
      });
      pendingDOMUpdates.clear();
      rafScheduled = false;
    });
  }
};

// Performance: Optimized element cache getter
const getCachedElements = (blockDiv: HTMLElement): {
  functionNameElement?: HTMLDivElement;
  paramsContainer?: HTMLDivElement;
  buttonContainer?: HTMLDivElement;
} => {
  const now = Date.now();
  let cache = elementQueryCache.get(blockDiv);
  
  // Cache for 1 second to reduce DOM queries
  if (!cache || (now - cache.lastCacheTime) > 1000) {
    cache = {
      functionNameElement: blockDiv.querySelector<HTMLDivElement>('.function-name') || undefined,
      paramsContainer: blockDiv.querySelector<HTMLDivElement>('.function-params') || undefined,
      buttonContainer: blockDiv.querySelector<HTMLDivElement>('.function-buttons') || undefined,
      lastCacheTime: now
    };
    elementQueryCache.set(blockDiv, cache);
  }
  
  return cache;
};

// Performance: Optimized content parsing with caching
const parseContentEfficiently = (block: HTMLElement, rawContent: string): {
  functionName: string;
  callId: string;
  parameters: Record<string, string>;
} => {
  const contentHash = generateContentHash(rawContent);
  let cached = contentParsingCache.get(block);
  
  if (cached && cached.lastHash === contentHash) {
    return {
      functionName: cached.functionName,
      callId: cached.callId,
      parameters: cached.parameters
    };
  }
  
  // Parse content efficiently
  const invokeMatch = REGEX_CACHE.invokeMatch.exec(rawContent);
  const functionName = invokeMatch ? invokeMatch[1] : 'function';
  const callId = invokeMatch && invokeMatch[2] ? invokeMatch[2] : `block-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  
  // Parse parameters in a single pass
  const parameters: Record<string, string> = {};
  REGEX_CACHE.paramStartRegex.lastIndex = 0; // Reset regex state
  
  let match;
  while ((match = REGEX_CACHE.paramStartRegex.exec(rawContent)) !== null) {
    const paramName = match[1];
    const startIndex = match.index + match[0].length;
    const endTagIndex = rawContent.indexOf(REGEX_CACHE.endParameterTag, startIndex);
    
    let extractedValue = '';
    if (endTagIndex !== -1) {
      extractedValue = rawContent.substring(startIndex, endTagIndex);
    } else {
      extractedValue = rawContent.substring(startIndex);
    }
    
    // Handle CDATA efficiently
    const cdataMatch = REGEX_CACHE.cdataMatch.exec(extractedValue);
    if (cdataMatch) {
      extractedValue = cdataMatch[1];
    } else {
      extractedValue = extractedValue.trim();
    }
    
    parameters[paramName] = extractedValue;
  }
  
  // Cache the results
  cached = {
    content: rawContent,
    functionName,
    callId,
    parameters,
    lastHash: contentHash
  };
  contentParsingCache.set(block, cached);
  
  return { functionName, callId, parameters };
};

// Performance: Cleanup timeout management
const cleanupTimeout = (key: string): void => {
  const timeoutId = activeTimeouts.get(key);
  if (timeoutId) {
    clearTimeout(timeoutId);
    activeTimeouts.delete(key);
  }
};

// Performance: Set managed timeout
const setManagedTimeout = (key: string, callback: () => void, delay: number): void => {
  cleanupTimeout(key);
  const timeoutId = window.setTimeout(() => {
    callback();
    activeTimeouts.delete(key);
  }, delay);
  activeTimeouts.set(key, timeoutId);
};

// Maximum number of retry attempts before giving up on auto-execution
const MAX_AUTO_EXECUTE_ATTEMPTS = 3;

// Centralized execution tracking system to prevent race conditions and duplicate executions
interface ExecutionTracker {
  // Track auto-execution attempts to prevent endless retries for removed blocks
  attempts: Map<string, number>;
  // Track blocks that have been successfully auto-executed or are in progress
  executed: Set<string>;
  // Track function call signatures (callId + contentSignature) that have been executed
  executedFunctions: Set<string>;
  // Check if a function has been executed or is scheduled for execution
  isFunctionExecuted(callId: string, contentSignature: string, functionName?: string): boolean;
  // Mark a function as executed or in progress
  markFunctionExecuted(callId: string, contentSignature: string, functionName?: string): void;
  // Check if a block has been auto-executed
  isBlockExecuted(blockId: string): boolean;
  // Mark a block as auto-executed
  markBlockExecuted(blockId: string): void;
  // Get attempts for a block
  getAttempts(blockId: string): number;
  // Increment attempts for a block
  incrementAttempts(blockId: string): number;
  // Clean up tracking data for a block
  cleanupBlock(blockId: string): void;
}

// Implementation of the execution tracker
export const executionTracker: ExecutionTracker = {
  attempts: new Map<string, number>(),
  executed: new Set<string>(),
  executedFunctions: new Set<string>(),

  isFunctionExecuted(callId: string, contentSignature: string, functionName?: string): boolean {
    console.debug(
      `[Debug] isFunctionExecuted called with: callId='${callId}', signature='${contentSignature}', funcName='${functionName || 'undefined'}'`,
    );

    // Determine the function name to use (prefer provided, fallback to extracting from memory)
    let effectiveFunctionName = functionName;
    let foundNameInMemory = false;

    // Try to extract from executedFunctions set keys IF functionName was NOT provided initially
    if (typeof effectiveFunctionName === 'undefined' || effectiveFunctionName === null) {
      let functionNameFromMemory = '';
      for (const key of this.executedFunctions) {
        const parts = key.split(':');
        if (parts.length === 3 && parts[1] === callId && parts[2] === contentSignature) {
          functionNameFromMemory = parts[0];
          break;
        }
      }
      if (functionNameFromMemory) {
        effectiveFunctionName = functionNameFromMemory; // Set effectiveFunctionName if found in memory
        foundNameInMemory = true;
        console.debug(`[Debug] Found functionName='${effectiveFunctionName}' from executedFunctions set`);
      }
    }

    // Use Standard Check if we have a function name (either passed or found in memory)
    if (typeof effectiveFunctionName === 'string') {
      // Check if we have *any* string name
      const key = `${effectiveFunctionName}:${callId}:${contentSignature}`;
      const inMemory = this.executedFunctions.has(key);
      // Use the specific function name for storage lookup
      const inStorage = getPreviousExecution(effectiveFunctionName, callId, contentSignature) !== null;
      console.debug(
        `[Debug] isFunctionExecuted (Standard Check): Key='${key}', inMemory=${inMemory}, inStorage=${inStorage}`,
      );
      return inMemory || inStorage;
    }
    // Fallback to Legacy Check ONLY if no function name was passed AND none was found in memory
    else {
      const key = `${callId}:${contentSignature}`;
      const inMemory = this.executedFunctions.has(key) || this.executedFunctions.has(`:${callId}:${contentSignature}`); // Check legacy key format too
      const inStorage = getPreviousExecutionLegacy(callId, contentSignature) !== null;
      console.debug(
        `[Debug] isFunctionExecuted (Legacy Check): Key='${key}', inMemory=${inMemory}, inStorage=${inStorage}`,
      );
      return inMemory || inStorage;
    }
  },

  markFunctionExecuted(callId: string, contentSignature: string, functionName?: string): void {
    // Use the function name if provided, otherwise just use callId and contentSignature
    const key = functionName ? `${functionName}:${callId}:${contentSignature}` : `${callId}:${contentSignature}`;
    this.executedFunctions.add(key);
  },

  isBlockExecuted(blockId: string): boolean {
    return this.executed.has(blockId) === true;
  },

  markBlockExecuted(blockId: string): void {
    this.executed.add(blockId);
  },

  getAttempts(blockId: string): number {
    return this.attempts.get(blockId) || 0;
  },

  incrementAttempts(blockId: string): number {
    const current = this.getAttempts(blockId);
    const newValue = current + 1;
    this.attempts.set(blockId, newValue);
    return newValue;
  },

  cleanupBlock(blockId: string): void {
    this.attempts.delete(blockId);
  },
};

/**
 * Main function to render a function call block
 *
 * @param block HTML element containing a function call
 * @param isProcessingRef Reference to processing state
 * @returns Boolean indicating whether rendering was successful
 */
// Configure Monaco once before rendering any blocks
if (typeof window !== 'undefined') {
  configureMonacoEditorForCSP();
}

export const renderFunctionCall = (block: HTMLPreElement, isProcessingRef: { current: boolean }): boolean => {
  const functionInfo = containsFunctionCalls(block);

  // Early exit for non-function call content or already rendered blocks
  if (!functionInfo.hasFunctionCalls || block.closest('.function-block')) {
    return false;
  }

  // Quick check for minimal content - avoid processing if element is essentially empty
  const textContent = block.textContent?.trim() || '';
  if (textContent.length < 10) { // Minimum reasonable length for a function call
    return false;
  }

  const blockId =
    block.getAttribute('data-block-id') || `block-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  // Get the set of pre-existing incomplete blocks if it exists
  const preExistingIncompleteBlocks = (window as any).preExistingIncompleteBlocks || new Set<string>();

  // Check if this is a pre-existing incomplete block that should not get spinners
  const isPreExistingIncomplete = preExistingIncompleteBlocks.has(blockId);

  let existingDiv = renderedFunctionBlocks.get(blockId);
  let isNewRender = false;
  let previousCompletionStatus: boolean | null = null;

  // Performance: Optimize existing div lookup with better caching
  if (processedElements.has(block)) {
    if (!existingDiv) {
      // Use more efficient querySelector instead of querySelectorAll
      existingDiv = document.querySelector<HTMLDivElement>(`.function-block[data-block-id="${blockId}"]`) || undefined;
      if (existingDiv) {
        renderedFunctionBlocks.set(blockId, existingDiv);
      } else {
        processedElements.delete(block);
      }
    }
  }

  if (!existingDiv) {
    isNewRender = true;
    if (!processedElements.has(block)) {
      processedElements.add(block);
      block.setAttribute('data-block-id', blockId);
    }
  } else {
    previousCompletionStatus = !existingDiv.classList.contains('function-loading');
  }

  const rawContent = block.textContent?.trim() || '';
  const { tag, content } = extractLanguageTag(rawContent);

  // Performance: Parse content efficiently with caching
  const { functionName, callId, parameters: partialParameters } = parseContentEfficiently(block, rawContent);

  // CRITICAL: Use the existing div if available for streaming updates, or create a new one
  const blockDiv = existingDiv || document.createElement('div');

  // Only update these properties on a new render, not during streaming updates
  if (isNewRender) {
    blockDiv.className = 'function-block';
    blockDiv.setAttribute('data-block-id', blockId);

    // Apply theme class based on current theme
    applyThemeClass(blockDiv);

    // Register this block
    renderedFunctionBlocks.set(blockId, blockDiv);
  }

  // Handle state transitions when block completion status changes
  if (!isNewRender) {
    const justCompleted = previousCompletionStatus === false && functionInfo.isComplete;
    const justBecameIncomplete = previousCompletionStatus === true && !functionInfo.isComplete;

    if (justCompleted) {
      // Update UI state when transitioning from loading to complete
      blockDiv.classList.remove('function-loading');
      blockDiv.classList.add('function-complete');

      // Remove spinner if exists
      const spinner = blockDiv.querySelector('.spinner');
      if (spinner) {
        spinner.remove();
      }
    } else if (justBecameIncomplete) {
      // Update UI state when transitioning from complete to loading
      blockDiv.classList.remove('function-complete');
      blockDiv.classList.add('function-loading');
    }
  } else {
    // Only add loading state for new renders if not pre-existing incomplete
    if (!functionInfo.isComplete && !isPreExistingIncomplete) {
      blockDiv.classList.add('function-loading');
    }

    // Add language tag if needed for new renders
    if (tag || functionInfo.languageTag) {
      const langTag = document.createElement('div');
      langTag.className = 'language-tag';
      langTag.textContent = tag || functionInfo.languageTag;
      blockDiv.appendChild(langTag);
    }
  }

  // Performance: Use cached elements instead of querying DOM repeatedly
  const cachedElements = getCachedElements(blockDiv);

  // Handle function name creation or update
  let functionNameElement = cachedElements.functionNameElement;

  if (!functionNameElement) {
    // Create function name if not exists (new render)
    functionNameElement = document.createElement('div');
    functionNameElement.className = 'function-name';

    // Create left section for function name and spinner
    const leftSection = document.createElement('div');
    leftSection.className = 'function-name-left';

    const functionNameText = document.createElement('span');
    functionNameText.className = 'function-name-text';
    functionNameText.textContent = functionName;
    leftSection.appendChild(functionNameText);

    // If function is not complete and not a pre-existing incomplete block, add spinner
    if (!functionInfo.isComplete && !isPreExistingIncomplete) {
      const spinner = document.createElement('div');
      spinner.className = 'spinner';
      leftSection.appendChild(spinner);
    }

    // Create right section for expand button and call ID
    const rightSection = document.createElement('div');
    rightSection.className = 'function-name-right';

    functionNameElement.appendChild(leftSection);
    functionNameElement.appendChild(rightSection);

    // Add call ID to the right section
    if (callId) {
      const callIdElement = document.createElement('span');
      callIdElement.className = 'call-id';
      callIdElement.textContent = callId;
      rightSection.appendChild(callIdElement);
    }

    blockDiv.appendChild(functionNameElement);
    
    // Update cache
    cachedElements.functionNameElement = functionNameElement;
    elementQueryCache.set(blockDiv, { ...cachedElements, lastCacheTime: Date.now() });
  } else {
    // Update existing function name (streaming update)
    const nameText = functionNameElement.querySelector<HTMLSpanElement>('.function-name-text');
    if (nameText && nameText.textContent !== functionName) {
      nameText.textContent = functionName;
    }

    // Update call ID if needed
    const callIdElement = functionNameElement.querySelector<HTMLSpanElement>('.call-id');
    if (callId) {
      if (callIdElement) {
        if (callIdElement.textContent !== callId) {
          callIdElement.textContent = callId;
        }
      } else {
        const newCallId = document.createElement('span');
        newCallId.className = 'call-id';
        newCallId.textContent = callId;
        functionNameElement.appendChild(newCallId);
      }
    }
  }

  // Create expand/collapse functionality for the function block
  let expandButton = functionNameElement?.querySelector('.expand-button') as HTMLButtonElement | null;
  
  if (!expandButton && functionNameElement) {
    // Create expand button
    expandButton = document.createElement('button');
    expandButton.className = 'expand-button';
    expandButton.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 10l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    expandButton.title = 'Expand function details';
    
    // Add expand button to the right section
    const rightSection = functionNameElement.querySelector('.function-name-right');
    if (rightSection) {
      rightSection.appendChild(expandButton);
    } else {
      functionNameElement.appendChild(expandButton);
    }
  }

  // Get existing or create expandable content and parameter container
  let paramsContainer = cachedElements.paramsContainer;
  let expandableContent = blockDiv.querySelector('.expandable-content') as HTMLDivElement | null;

  // Always create expandable content wrapper if it doesn't exist
  if (!expandableContent) {
    expandableContent = document.createElement('div');
    expandableContent.className = 'expandable-content';
    expandableContent.style.display = 'none'; // Initially collapsed
    expandableContent.style.overflow = 'hidden';
    expandableContent.style.transition = 'all 0.3s ease-in-out';
    expandableContent.style.maxHeight = '0px';
    expandableContent.style.opacity = '0';
    blockDiv.appendChild(expandableContent);
  }

  // Create parameter container if it doesn't exist
  if (!paramsContainer) {
    paramsContainer = document.createElement('div');
    paramsContainer.className = 'function-params';
    
    // Performance: Batch style updates
    Object.assign(paramsContainer.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      width: '100%'
    });
    
    expandableContent.appendChild(paramsContainer);
    
    // Update cache
    cachedElements.paramsContainer = paramsContainer;
    elementQueryCache.set(blockDiv, { ...cachedElements, lastCacheTime: Date.now() });
  }

  // Setup expand/collapse functionality
  if (expandButton && expandableContent) {
    const isExpanded = blockDiv.classList.contains('expanded');
    
    expandButton.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      const isCurrentlyExpanded = blockDiv.classList.contains('expanded');
      const expandIcon = expandButton.querySelector('svg path');
      
      if (isCurrentlyExpanded) {
        // Collapse - get current height first for smooth transition
        const currentHeight = expandableContent.scrollHeight;
        expandableContent.style.maxHeight = currentHeight + 'px';
        
        // Force reflow
        expandableContent.offsetHeight;
        
        // Start collapse animation
        requestAnimationFrame(() => {
          blockDiv.classList.remove('expanded');
          expandableContent.style.maxHeight = '0px';
          expandableContent.style.opacity = '0';
          expandableContent.style.paddingTop = '0';
          expandableContent.style.paddingBottom = '0';
          
          if (expandIcon) {
            expandIcon.setAttribute('d', 'M8 10l4 4 4-4');
          }
          expandButton.title = 'Expand function details';
        });
        
        // Hide after animation completes
        setTimeout(() => {
          if (!blockDiv.classList.contains('expanded')) {
            expandableContent.style.display = 'none';
          }
        }, 400); // Match transition duration
      } else {
        // Expand - prepare for smooth animation
        blockDiv.classList.add('expanded');
        expandableContent.style.display = 'block';
        expandableContent.style.maxHeight = '0px';
        expandableContent.style.opacity = '0';
        expandableContent.style.paddingTop = '0';
        expandableContent.style.paddingBottom = '0';
        
        // Get target height
        const targetHeight = expandableContent.scrollHeight;
        
        // Start expand animation
        requestAnimationFrame(() => {
          expandableContent.style.maxHeight = targetHeight + 'px';
          expandableContent.style.opacity = '1';
          expandableContent.style.paddingTop = '12px';
          expandableContent.style.paddingBottom = '12px';
          
          if (expandIcon) {
            expandIcon.setAttribute('d', 'M16 14l-4-4-4 4');
          }
          expandButton.title = 'Collapse function details';
        });
        
        // Wait longer than transition duration to remove explicit height smoothly
        setTimeout(() => {
          if (blockDiv.classList.contains('expanded')) {
            // Gradually transition to auto height to prevent jerk
            expandableContent.style.transition = 'none';
            expandableContent.style.maxHeight = 'none';
            
            // Re-enable transitions after a frame
            requestAnimationFrame(() => {
              expandableContent.style.transition = '';
            });
          }
        }, 600); // Wait longer than the 500ms transition
      }
    };
  }

  // Performance: Use pre-parsed parameters from efficient parsing
  Object.entries(partialParameters).forEach(([paramName, extractedValue]) => {
    const isParamStreaming = !rawContent.includes(`</parameter>`) || 
      rawContent.indexOf('</parameter>', rawContent.indexOf(`<parameter name="${paramName}"`)) === -1;
    
    // Performance: Batch parameter updates using RAF
    batchDOMOperation(blockId, () => {
      createOrUpdateParamElement(paramsContainer!, paramName, extractedValue, blockId, isNewRender, isParamStreaming);
    });
  });

  // Extract *complete* parameters using the function from components.ts *only when needed*
  let completeParameters: Record<string, any> | null = null;
  if (functionInfo.isComplete) {
    completeParameters = extractFunctionParameters(rawContent);
  }

  // Generate content signature *only* when complete
  let contentSignature: string | null = null;
  if (functionInfo.isComplete && completeParameters) {
    contentSignature = generateContentSignature(functionName, completeParameters);
  }

  // Only replace the original element with our render if this is a new render
  if (isNewRender) {
    if (block.parentNode) {
      block.parentNode.insertBefore(blockDiv, block);
      block.style.display = 'none';
    } else {
      if (CONFIG.debug) console.warn('Function call block has no parent element, cannot insert rendered block');
      return false;
    }
  }

  // Create a button container if it doesn't exist - buttons should always be visible
  let buttonContainer = cachedElements.buttonContainer;
  if (!buttonContainer) {
    // Create a container for the buttons
    buttonContainer = document.createElement('div');
    buttonContainer.className = 'function-buttons';
    buttonContainer.style.marginTop = '12px';
    
    // Add buttons after expandable content (so they're always visible)
    blockDiv.appendChild(buttonContainer);
    
    // Update cache
    cachedElements.buttonContainer = buttonContainer;
    elementQueryCache.set(blockDiv, { ...cachedElements, lastCacheTime: Date.now() });
  }

  // Add a raw XML toggle if the function is complete
  if (functionInfo.isComplete && !blockDiv.querySelector('.raw-toggle')) {
    // Always use the button container for buttons
    addRawXmlToggle(buttonContainer!, rawContent);
  }

  // Add execute button if the function is complete and not already added
  if (functionInfo.isComplete && !blockDiv.querySelector('.execute-button')) {
    // Ensure completeParameters is available before adding button/setting up auto-exec
    if (!completeParameters) {
      completeParameters = extractFunctionParameters(rawContent);
    }
    // Always use the button container for buttons
    addExecuteButton(buttonContainer!, rawContent); // rawContent has full data here

    // Setup auto-execution with proper wait time for DOM stabilization
    // This ensures we wait until the function block is fully rendered and stable
    const autoExecuteEnabled = (window as any).toggleState?.autoExecute === true;

    // Check if the function has already been executed using the complete signature
    if (contentSignature && !executionTracker.isFunctionExecuted(callId, contentSignature, functionName)) {
      // Proceed with auto-execution setup
      // STRICT CHECK #1: Is auto-execute enabled in UI settings?
      if (autoExecuteEnabled !== true) {
        console.debug(`Auto-execution disabled by user settings for block ${blockId} (${functionName})`);
        return true;
      }

      // STRICT CHECK #2: Has this block already been processed for auto-execution?
      if (executionTracker.isBlockExecuted(blockId) === true) {
        console.debug(`Auto-execution skipped: Block ${blockId} (${functionName}) has already been processed`);
        return true;
      }

      // At this point, we've passed all checks and can proceed with auto-execution
      // Immediately mark function as scheduled for execution to prevent race conditions
      executionTracker.markFunctionExecuted(callId, contentSignature, functionName);
      executionTracker.markBlockExecuted(blockId);

      console.debug(`Setting up auto-execution for block ${blockId} (${functionName})`);

      // Store function details for use in the retry mechanism (use completeParameters)
      const functionDetails = {
        functionName,
        callId,
        contentSignature,
        params: completeParameters || {}, // Ensure params is an object
      };
      
      // Performance: Use optimized auto-execution setup
      setupOptimizedAutoExecution(blockId, functionDetails);
    }
  }

  return true;
};

// Performance: Optimized auto-execution setup with better resource management
const setupOptimizedAutoExecution = (blockId: string, functionDetails: any): void => {
  const setupAutoExecution = () => {
    const attempts = executionTracker.incrementAttempts(blockId);

    if (attempts > MAX_AUTO_EXECUTE_ATTEMPTS) {
      console.debug(`Auto-execute: Giving up on block ${blockId} after ${attempts - 1} attempts`);
      executionTracker.cleanupBlock(blockId);
      return;
    }

    console.debug(`Auto-execute attempt ${attempts}/${MAX_AUTO_EXECUTE_ATTEMPTS} for block ${blockId}`);

    // Performance: Use managed timeout instead of raw setTimeout
    setManagedTimeout(`auto-exec-${blockId}-${attempts}`, () => {
      let currentBlock = document.querySelector<HTMLDivElement>(`.function-block[data-block-id="${blockId}"]`);

      if (!currentBlock) {
        console.debug(`Auto-execute: Original block ${blockId} not found. Searching for replacement...`);
        
        // Performance: Use more efficient replacement block search
        const potentialBlocks = document.querySelectorAll<HTMLDivElement>('.function-block');
        for (const block of potentialBlocks) {
          const preElement = block.querySelector('pre');
          if (!preElement?.textContent) continue;

          // Use cached regex for better performance
          const match = REGEX_CACHE.invokeMatch.exec(preElement.textContent);
          REGEX_CACHE.invokeMatch.lastIndex = 0; // Reset regex state

          if (match && match[1] === functionDetails.functionName && match[2] === functionDetails.callId) {
            const alreadyExecuted = getPreviousExecution(
              functionDetails.functionName,
              functionDetails.callId,
              functionDetails.contentSignature,
            );

            if (!alreadyExecuted) {
              console.debug(`Auto-execute: Found replacement block, attempting execution.`);
              currentBlock = block;
              break;
            }
          }
        }
      }

      if (!currentBlock) {
        console.debug(`Auto-execute: Block ${blockId} not found (attempt ${attempts}/${MAX_AUTO_EXECUTE_ATTEMPTS})`);
        if (attempts < MAX_AUTO_EXECUTE_ATTEMPTS) {
          setupAutoExecution(); // Retry without additional timeout
        } else {
          console.debug(`Auto-execute: Giving up on block ${blockId} - not found in DOM`);
          executionTracker.cleanupBlock(blockId);
        }
        return;
      }

      // Final storage check
      const finalCheckExecuted = getPreviousExecution(
        functionDetails.functionName,
        functionDetails.callId,
        functionDetails.contentSignature,
      );
      if (finalCheckExecuted) {
        console.debug(`Auto-execute: Function already executed, skipping.`);
        executionTracker.cleanupBlock(blockId);
        return;
      }

      const executeButton = currentBlock.querySelector<HTMLButtonElement>('.execute-button');
      if (executeButton) {
        console.debug(`Auto-execute: Executing function ${functionDetails.functionName}`);
        executeButton.click();
        executionTracker.cleanupBlock(blockId);
      } else {
        console.debug(`Auto-execute: Execute button not found (attempt ${attempts}/${MAX_AUTO_EXECUTE_ATTEMPTS})`);
        if (attempts < MAX_AUTO_EXECUTE_ATTEMPTS) {
          setupAutoExecution(); // Retry
        } else {
          console.debug(`Auto-execute: Giving up on block ${blockId} - button not found`);
          executionTracker.cleanupBlock(blockId);
        }
      }
    }, 500); // Optimized delay
  };

  setupAutoExecution();
};

/**
 * Create or update a parameter element in the function block
 * Performance optimized version with reduced DOM queries and better caching
 */
export const createOrUpdateParamElement = (
  container: HTMLDivElement,
  name: string,
  value: any,
  blockId: string,
  isNewRender: boolean,
  isStreaming: boolean = false,
): void => {
  const paramId = `${blockId}-${name}`;

  // Performance: Cache parameter elements to avoid repeated queries
  const paramElementCache = elementQueryCache.get(container) || { lastCacheTime: Date.now() };
  const paramCache = paramElementCache as any; // Use any for dynamic keys
  let paramNameElement = paramCache[`name-${paramId}`] as HTMLDivElement | undefined;
  let paramValueElement = paramCache[`value-${paramId}`] as HTMLDivElement | undefined;

  // Only query DOM if not in cache
  if (!paramNameElement || !paramValueElement) {
    paramNameElement = paramNameElement || 
                     container.querySelector<HTMLDivElement>(`.param-name[data-param-id="${paramId}"]`) || 
                     document.querySelector<HTMLDivElement>(`.param-name[data-param-id="${paramId}"]`) || 
                     undefined;
    paramValueElement = paramValueElement ||
                       container.querySelector<HTMLDivElement>(`.param-value[data-param-id="${paramId}"]`) || 
                       document.querySelector<HTMLDivElement>(`.param-value[data-param-id="${paramId}"]`) ||
                       undefined;
    
    // Update cache
    if (paramNameElement) paramCache[`name-${paramId}`] = paramNameElement;
    if (paramValueElement) paramCache[`value-${paramId}`] = paramValueElement;
    elementQueryCache.set(container, paramCache);
  }

  // Create parameter name element if it doesn't exist
  if (!paramNameElement) {
    paramNameElement = document.createElement('div');
    paramNameElement.className = 'param-name';
    paramNameElement.textContent = name;
    paramNameElement.setAttribute('data-param-id', paramId);
    container.appendChild(paramNameElement);
    
    // Update cache
    paramCache[`name-${paramId}`] = paramNameElement;
    elementQueryCache.set(container, paramCache);
  }

  // Create parameter value element if it doesn't exist
  if (!paramValueElement) {
    paramValueElement = document.createElement('div');
    paramValueElement.className = 'param-value';
    paramValueElement.setAttribute('data-param-id', paramId);
    paramValueElement.setAttribute('data-param-name', name);
    container.appendChild(paramValueElement);
    
    // Update cache
    paramCache[`value-${paramId}`] = paramValueElement;
    elementQueryCache.set(container, paramCache);
  }

  // Performance: Only update content if it has actually changed
  const displayValue = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  const currentValue = paramValueElement.getAttribute('data-current-value');
  
  if (currentValue === displayValue && !isStreaming) {
    return; // No update needed
  }

  // Update the stored value
  paramValueElement.setAttribute('data-current-value', displayValue);

  // Performance: Handle streaming updates more efficiently
  if (isStreaming || paramValueElement.hasAttribute('data-streaming')) {
    let preElement = paramValueElement.querySelector('pre');
    if (!preElement) {
      preElement = document.createElement('pre');
      
      // Performance: Batch style updates
      Object.assign(preElement.style, {
        margin: '0',
        padding: '0',
        whiteSpace: 'pre-wrap',
        width: '100%',
        height: '100%',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        lineHeight: '1.5'
      });

      // Clear and append efficiently
      paramValueElement.textContent = '';
      paramValueElement.appendChild(preElement);
    }

    // Performance: Only update if content actually changed
    if (preElement.textContent !== displayValue) {
      preElement.textContent = displayValue;
    }
  } else {
    // Performance: Only update if content actually changed
    if (paramValueElement.textContent !== displayValue) {
      paramValueElement.textContent = displayValue;
    }
  }

  // Set the parameter value attribute
  paramValueElement.setAttribute('data-param-value', JSON.stringify(value));

  // Performance: Only apply overflow styles when needed
  if (paramValueElement.scrollHeight > 300) {
    Object.assign(paramValueElement.style, {
      overflow: 'auto',
      scrollBehavior: 'smooth'
    });
  }

  // Performance: Optimized timeout management
  const timeoutKey = `streaming-timeout-${paramId}`;
  cleanupTimeout(timeoutKey);

  // Handle streaming state efficiently
  if (isStreaming) {
    // Performance: Batch DOM class changes
    if (!paramNameElement.classList.contains('streaming-param-name')) {
      paramNameElement.classList.add('streaming-param-name');
    }
    paramValueElement.setAttribute('data-streaming', 'true');

    // Performance: Apply streaming styles only once
    if (!paramValueElement.hasAttribute('data-streaming-styled')) {
      Object.assign(paramValueElement.style, {
        overflow: 'auto',
        maxHeight: '300px',
        scrollBehavior: 'smooth'
      });
      paramValueElement.setAttribute('data-streaming-styled', 'true');
    }

    // Setup auto-scroll for the parameter value element
    setupAutoScroll(paramValueElement as ParamValueElement);

    // Performance: Optimized scrolling with RAF
    const performOptimizedScroll = () => {
      const preElement = paramValueElement.querySelector('pre');
      
      requestAnimationFrame(() => {
        if (paramValueElement.scrollHeight > paramValueElement.clientHeight && 
            !(paramValueElement as any)._userHasScrolled) {
          paramValueElement.scrollTop = paramValueElement.scrollHeight;
        }

        if (preElement && preElement.scrollHeight > preElement.clientHeight && 
            !(preElement as any)._userHasScrolled) {
          preElement.scrollTop = preElement.scrollHeight;
        }
      });
    };

    performOptimizedScroll();

    // Performance: Use managed timeout for cleanup
    setManagedTimeout(timeoutKey, () => {
      if (paramNameElement && document.body.contains(paramNameElement)) {
        paramNameElement.classList.remove('streaming-param-name');
        if (paramValueElement) {
          paramValueElement.removeAttribute('data-streaming');
          paramValueElement.removeAttribute('data-streaming-styled');
        }
      }
    }, 2000); // Reduced timeout for more responsive feedback
  } else {
    // Performance: Only clean up if previously streaming
    if (paramNameElement.classList.contains('streaming-param-name')) {
      paramNameElement.classList.remove('streaming-param-name');
      paramValueElement.removeAttribute('data-streaming');
      paramValueElement.removeAttribute('data-streaming-styled');
    }
  }
};

// Performance: Cleanup functions for memory management
export const performanceCleanup = {
  // Clear all caches (WeakMaps will be garbage collected when their keys are removed)
  clearAllCaches: (): void => {
    renderedFunctionBlocks.clear();
    pendingDOMUpdates.clear();
    
    // Clean up active timeouts
    activeTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
    activeTimeouts.clear();
    
    // Note: WeakMaps (contentParsingCache, elementQueryCache) will be automatically 
    // garbage collected when their associated elements are removed from DOM
  },

  // Clear cache for specific block
  clearBlockCache: (blockId: string): void => {
    // Remove from rendered blocks
    renderedFunctionBlocks.delete(blockId);
    
    // Clear any pending operations for this block
    pendingDOMUpdates.delete(blockId);
    
    // Clean up timeouts for this block
    const timeoutKeysToClean = Array.from(activeTimeouts.keys()).filter(key => 
      key.includes(blockId)
    );
    timeoutKeysToClean.forEach(key => {
      const timeoutId = activeTimeouts.get(key);
      if (timeoutId) {
        clearTimeout(timeoutId);
        activeTimeouts.delete(key);
      }
    });
  },

  // Get cache statistics
  getCacheStats: () => ({
    contentParsingCacheSize: 'WeakMap (size not available - auto-managed)',
    elementQueryCacheSize: 'WeakMap (size not available - auto-managed)',
    renderedFunctionBlocksSize: renderedFunctionBlocks.size,
    pendingDOMUpdatesSize: pendingDOMUpdates.size,
    activeTimeoutsSize: activeTimeouts.size
  })
};

// Performance: Export utilities for external monitoring
export const performanceUtils = {
  generateContentHash,
  parseContentEfficiently,
  batchDOMOperation,
  getCachedElements,
  cleanupTimeout,
  setManagedTimeout,
  REGEX_CACHE
};

// Cleanup on page unload to prevent memory leaks
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    performanceCleanup.clearAllCaches();
  });
}
