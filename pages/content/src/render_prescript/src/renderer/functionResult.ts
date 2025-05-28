import { CONFIG } from '../core/config';
import { safelySetContent } from '../utils/index';
import { applyThemeClass } from '../utils/themeDetector';
import { isDarkTheme } from '../utils/themeDetector';

// State management for rendered elements
export const processedResultElements = new WeakSet<HTMLElement>();
export const renderedFunctionResults = new Map<string, HTMLDivElement>();
/**
 * Renders a system message box
 * 
 * @param block HTML element to render the system message in
 * @param content The system message content
 */
const renderSystemMessageBox = (block: HTMLElement, content: string): void => {
  try {
    // Generate a unique ID for this block
    const blockId = `system-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    block.setAttribute('data-block-id', blockId);

    // Create a container for the system message
    const systemContainer = document.createElement('div');
    systemContainer.className = 'function-block system-message-container';
    systemContainer.setAttribute('data-block-id', blockId);
    systemContainer.style.width = '100%';
    systemContainer.style.boxSizing = 'border-box';
    
    // Apply theme class
    if (CONFIG.useHostTheme) {
      applyThemeClass(systemContainer);
      // Add theme-specific class
      if (isDarkTheme()) {
        systemContainer.classList.add('theme-dark');
      } else {
        systemContainer.classList.add('theme-light');
      }
    }

    // Create header
    const header = document.createElement('div');
    header.className = 'function-name system-header';
    
    // Create left section for system message label
    const leftSection = document.createElement('div');
    leftSection.className = 'function-name-left';
    
    const nameText = document.createElement('div');
    nameText.className = 'function-name-text';
    nameText.textContent = 'MCP SuperAssistant';
    leftSection.appendChild(nameText);
    
    // Create right section for expand button
    const rightSection = document.createElement('div');
    rightSection.className = 'function-name-right';
    
    // Create expand button
    const expandButton = document.createElement('button');
    expandButton.className = 'expand-button';
    expandButton.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 10l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    expandButton.title = 'Expand system message';
    rightSection.appendChild(expandButton);
    
    header.appendChild(leftSection);
    header.appendChild(rightSection);

    // Create expandable content wrapper
    const expandableContent = document.createElement('div');
    expandableContent.className = 'expandable-content';
    expandableContent.style.overflow = 'hidden';
    expandableContent.style.maxHeight = '0px';
    expandableContent.style.opacity = '0';
    expandableContent.style.padding = '0 12px';
    expandableContent.style.width = '100%';
    expandableContent.style.boxSizing = 'border-box';

    // Create content area inside expandable wrapper
    const contentArea = document.createElement('div');
    contentArea.className = 'param-value system-message-content';
    contentArea.style.width = '100%';
    contentArea.style.boxSizing = 'border-box';
    
    // Apply theme-specific styles to content area
    if (isDarkTheme()) {
      contentArea.style.backgroundColor = '#2d2d2d';
      contentArea.style.border = 'solid rgba(255, 255, 255, 0.1)';
      contentArea.style.color = '#e8eaed';
      // systemContainer.style.borderLeft = 'solid #8ab4f8';
    } else {
      contentArea.style.backgroundColor = '#f8f9fa';
      contentArea.style.border = 'solid rgba(0, 0, 0, 0.1)';
      contentArea.style.color = '#202124';
      // systemContainer.style.borderLeft = 'solid #1a73e8';
    }
    
    // Add the system message content
    contentArea.textContent = content;

    // Add content area to expandable wrapper
    expandableContent.appendChild(contentArea);

    // Setup expand/collapse functionality
    expandButton.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      const isCurrentlyExpanded = systemContainer.classList.contains('expanded');
      const expandIcon = expandButton.querySelector('svg path');
      
      if (isCurrentlyExpanded) {
        // Collapse - get current height first for smooth transition
        const currentHeight = expandableContent.scrollHeight;
        expandableContent.style.maxHeight = currentHeight + 'px';
        
        // Force reflow
        expandableContent.offsetHeight;
        
        // Start collapse animation
        requestAnimationFrame(() => {
          systemContainer.classList.remove('expanded');
          expandableContent.style.maxHeight = '0px';
          expandableContent.style.opacity = '0';
          expandableContent.style.paddingTop = '0';
          expandableContent.style.paddingBottom = '0';
          expandableContent.style.width = '100%';
          expandableContent.style.boxSizing = 'border-box';
          
          if (expandIcon) {
            expandIcon.setAttribute('d', 'M8 10l4 4 4-4');
          }
          expandButton.title = 'Expand system message';
        });
        
        // Hide after animation completes
        setTimeout(() => {
          if (!systemContainer.classList.contains('expanded')) {
            // Don't set display none as it affects width - just keep it collapsed
            expandableContent.style.width = '100%';
            expandableContent.style.boxSizing = 'border-box';
          }
        }, 500); // Match transition duration
      } else {
        // Expand - prepare for smooth animation
        systemContainer.classList.add('expanded');
        systemContainer.style.width = '100%';
        systemContainer.style.boxSizing = 'border-box';
        expandableContent.style.display = 'block';
        expandableContent.style.maxHeight = '0px';
        expandableContent.style.opacity = '0';
        expandableContent.style.paddingTop = '0';
        expandableContent.style.paddingBottom = '0';
        expandableContent.style.width = '100%';
        expandableContent.style.boxSizing = 'border-box';
        
        // Get target height
        const targetHeight = expandableContent.scrollHeight;
        
        // Start expand animation
        requestAnimationFrame(() => {
          expandableContent.style.maxHeight = targetHeight + 'px';
          expandableContent.style.opacity = '1';
          expandableContent.style.paddingTop = '12px';
          expandableContent.style.paddingBottom = '12px';
          expandableContent.style.width = '100%';
          expandableContent.style.boxSizing = 'border-box';
          
          if (expandIcon) {
            expandIcon.setAttribute('d', 'M16 14l-4-4-4 4');
          }
          expandButton.title = 'Collapse system message';
        });
        
        // Wait longer than transition duration to remove explicit height smoothly
        setTimeout(() => {
          if (systemContainer.classList.contains('expanded')) {
            // Gradually transition to auto height to prevent jerk
            expandableContent.style.transition = 'none';
            expandableContent.style.maxHeight = 'none';
            expandableContent.style.width = '100%';
            expandableContent.style.boxSizing = 'border-box';
            
            // Re-enable transitions after a frame
            requestAnimationFrame(() => {
              expandableContent.style.transition = '';
              expandableContent.style.width = '100%';
              expandableContent.style.boxSizing = 'border-box';
            });
          }
        }, 600); // Wait longer than the 500ms transition
      }
    };

    // Add components to container
    systemContainer.appendChild(header);
    systemContainer.appendChild(expandableContent);

    // Replace the original block with our rendered version
    while (block.firstChild) {
      block.removeChild(block.firstChild);
    }
    
    // Append our rendered container
    block.appendChild(systemContainer);
  } catch (e) {
    console.error('[renderSystemMessageBox] Error rendering system message:', e);
  }
};


/**
 * Main function to render a function result block
 *
 * @param block HTML element containing a function result
 * @param isProcessingRef Reference to processing state
 * @returns Boolean indicating whether rendering was successful
 */
export const renderFunctionResult = (block: HTMLElement, isProcessingRef: { current: boolean }): boolean => {
  try {
    // Skip if already processed
    if (processedResultElements.has(block)) {
      return false;
    }

    // Mark as processed to avoid duplicate processing
    processedResultElements.add(block);

    // Get the content of the block
    const content = block.textContent || '';

    // //check if it contains system message tags
    // if (content.includes('<SYSTEM>') || content.includes('</SYSTEM>')) {
    //   return false;
    // }

    // Check if it contains MCP SuperAssistant system message tags
    if (content.includes('<SYSTEM>') || content.includes('</SYSTEM>')) {
      // Extract content between SYSTEM tags
      const systemMatch = content;
      // const systemMatch = content.match(/<SYSTEM>([\s\S]*?)<\/SYSTEM>/);
      if (systemMatch) {
        const systemContent = systemMatch.trim();
        renderSystemMessageBox(block, systemContent);
        return true;
      }
    }

    // Check if it's a function result
    if (!content.includes('<function_result') && !content.includes('</function_result>')) {
      return false;
    }

    // Generate a unique ID for this block
    const blockId = `result-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    block.setAttribute('data-block-id', blockId);

    // Parse the function result content
    let resultContent = '';
    try {
      // Extract content between function_result tags
      const resultMatch = content.match(/<function_result[^>]*>([\s\S]*?)<\/function_result>/);
      if (resultMatch && resultMatch[1]) {
        resultContent = resultMatch[1].trim();
      }

      // Extract call_id if available
      const callIdMatch = content.match(/call_id="([^"]*)"/);
      const callId = callIdMatch ? callIdMatch[1] : '';

      // Create a container for the function result
      const resultContainer = document.createElement('div');
      resultContainer.className = 'function-block function-result-container';
      resultContainer.setAttribute('data-block-id', blockId);
      resultContainer.style.width = '100%';
      resultContainer.style.boxSizing = 'border-box';
      
      // Apply theme class
      if (CONFIG.useHostTheme) {
        applyThemeClass(resultContainer);
        // Add theme-specific class
        if (isDarkTheme()) {
          resultContainer.classList.add('theme-dark');
        } else {
          resultContainer.classList.add('theme-light');
        }
      }

      // Create header
      const header = document.createElement('div');
      header.className = 'function-name';
      
      // Create left section for function result label
      const leftSection = document.createElement('div');
      leftSection.className = 'function-name-left';
      
      const nameText = document.createElement('div');
      nameText.className = 'function-name-text';
      nameText.textContent = 'Function Result';
      leftSection.appendChild(nameText);
      
      // Create right section for call ID and expand button
      const rightSection = document.createElement('div');
      rightSection.className = 'function-name-right';
      
      // Add call ID if available
      if (callId) {
        const callIdElement = document.createElement('div');
        callIdElement.className = 'call-id';
        callIdElement.textContent = callId;
        rightSection.appendChild(callIdElement);
      }
      
      // Create expand button
      const expandButton = document.createElement('button');
      expandButton.className = 'expand-button';
      expandButton.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 10l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
      expandButton.title = 'Expand function result';
      rightSection.appendChild(expandButton);
      
      header.appendChild(leftSection);
      header.appendChild(rightSection);

      // Create expandable content wrapper
      const expandableContent = document.createElement('div');
      expandableContent.className = 'expandable-content';
      expandableContent.style.overflow = 'hidden';
      expandableContent.style.maxHeight = '0px';
      expandableContent.style.opacity = '0';
      expandableContent.style.padding = '0 12px';
      expandableContent.style.width = '100%';
      expandableContent.style.boxSizing = 'border-box';

      // Create content area inside expandable wrapper
      const contentArea = document.createElement('div');
      contentArea.className = 'param-value function-result-content';
      contentArea.style.width = '100%';
      contentArea.style.boxSizing = 'border-box';
      
      // Apply theme-specific styles to content area
      if (isDarkTheme()) {
        contentArea.style.backgroundColor = '#2d2d2d';
        contentArea.style.border = '1px solid rgba(255, 255, 255, 0.1)';
        contentArea.style.color = '#e8eaed';
      } else {
        contentArea.style.backgroundColor = '#f8f9fa';
        contentArea.style.border = '1px solid rgba(0, 0, 0, 0.1)';
        contentArea.style.color = '#202124';
      }

      // Try to parse the result as JSON
      try {
        const jsonResult = JSON.parse(resultContent);
        
        // If it's JSON and has content array, render it properly
        if (jsonResult && jsonResult.content && Array.isArray(jsonResult.content)) {
          // Render each content item
          jsonResult.content.forEach((item: any) => {
            if (item.type === 'text') {
              const textDiv = document.createElement('div');
              textDiv.className = 'function-result-text';
              textDiv.style.margin = '0 0 10px 0';
              textDiv.textContent = item.text;
              contentArea.appendChild(textDiv);
            } else if (item.type === 'image' && item.url) {
              const imgContainer = document.createElement('div');
              imgContainer.className = 'function-result-image';
              imgContainer.style.margin = '10px 0';
              
              const img = document.createElement('img');
              img.src = item.url;
              img.alt = item.alt || 'Image';
              img.style.maxWidth = '100%';
              img.style.borderRadius = '4px';
              
              imgContainer.appendChild(img);
              contentArea.appendChild(imgContainer);
            } else if (item.type === 'code' && item.code) {
              const codeContainer = document.createElement('div');
              codeContainer.className = 'function-result-code';
              codeContainer.style.margin = '10px 0';
              codeContainer.style.backgroundColor = 'rgba(0, 0, 0, 0.05)';
              codeContainer.style.borderRadius = '4px';
              codeContainer.style.padding = '10px';
              
              const pre = document.createElement('pre');
              pre.style.margin = '0';
              pre.style.whiteSpace = 'pre-wrap';
              pre.style.wordBreak = 'break-word';
              pre.style.fontFamily = 'monospace';
              pre.textContent = item.code;
              
              codeContainer.appendChild(pre);
              contentArea.appendChild(codeContainer);
            } else {
              // For unknown types, just render as JSON
              const unknownDiv = document.createElement('div');
              unknownDiv.className = 'function-result-unknown';
              unknownDiv.style.margin = '5px 0';
              unknownDiv.style.fontFamily = 'monospace';
              unknownDiv.style.fontSize = '12px';
              unknownDiv.textContent = JSON.stringify(item, null, 2);
              contentArea.appendChild(unknownDiv);
            }
          });
        } else {
          // If it's JSON but not in the expected format, format it nicely
          const pre = document.createElement('pre');
          pre.style.margin = '0';
          pre.style.whiteSpace = 'pre-wrap';
          pre.style.wordBreak = 'break-word';
          pre.style.fontFamily = 'monospace';
          pre.textContent = JSON.stringify(jsonResult, null, 2);
          contentArea.appendChild(pre);
        }
      } catch (e) {
        // If not JSON, just display as text
        contentArea.textContent = resultContent;
      }

      // Add content area to expandable wrapper
      expandableContent.appendChild(contentArea);

      // Add components to container
      resultContainer.appendChild(header);
      resultContainer.appendChild(expandableContent);

      // Setup expand/collapse functionality
      expandButton.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        const isCurrentlyExpanded = resultContainer.classList.contains('expanded');
        const expandIcon = expandButton.querySelector('svg path');
        
        if (isCurrentlyExpanded) {
          // Collapse - get current height first for smooth transition
          const currentHeight = expandableContent.scrollHeight;
          expandableContent.style.maxHeight = currentHeight + 'px';
          
          // Force reflow
          expandableContent.offsetHeight;
          
          // Start collapse animation
          requestAnimationFrame(() => {
            resultContainer.classList.remove('expanded');
            expandableContent.style.maxHeight = '0px';
            expandableContent.style.opacity = '0';
            expandableContent.style.paddingTop = '0';
            expandableContent.style.paddingBottom = '0';
            expandableContent.style.width = '100%';
            expandableContent.style.boxSizing = 'border-box';
            
            if (expandIcon) {
              expandIcon.setAttribute('d', 'M8 10l4 4 4-4');
            }
            expandButton.title = 'Expand function result';
          });
          
          // Hide after animation completes
          setTimeout(() => {
            if (!resultContainer.classList.contains('expanded')) {
              // Don't set display none as it affects width - just keep it collapsed
              expandableContent.style.width = '100%';
              expandableContent.style.boxSizing = 'border-box';
            }
          }, 500); // Match transition duration
        } else {
          // Expand - prepare for smooth animation
          resultContainer.classList.add('expanded');
          resultContainer.style.width = '100%';
          resultContainer.style.boxSizing = 'border-box';
          expandableContent.style.display = 'block';
          expandableContent.style.maxHeight = '0px';
          expandableContent.style.opacity = '0';
          expandableContent.style.paddingTop = '0';
          expandableContent.style.paddingBottom = '0';
          expandableContent.style.width = '100%';
          expandableContent.style.boxSizing = 'border-box';
          
          // Get target height
          const targetHeight = expandableContent.scrollHeight;
          
          // Start expand animation
          requestAnimationFrame(() => {
            expandableContent.style.maxHeight = targetHeight + 'px';
            expandableContent.style.opacity = '1';
            expandableContent.style.paddingTop = '12px';
            expandableContent.style.paddingBottom = '12px';
            expandableContent.style.width = '100%';
            expandableContent.style.boxSizing = 'border-box';
            
            if (expandIcon) {
              expandIcon.setAttribute('d', 'M16 14l-4-4-4 4');
            }
            expandButton.title = 'Collapse function result';
          });
          
          // Wait longer than transition duration to remove explicit height smoothly
          setTimeout(() => {
            if (resultContainer.classList.contains('expanded')) {
              // Gradually transition to auto height to prevent jerk
              expandableContent.style.transition = 'none';
              expandableContent.style.maxHeight = 'none';
              expandableContent.style.width = '100%';
              expandableContent.style.boxSizing = 'border-box';
              
              // Re-enable transitions after a frame
              requestAnimationFrame(() => {
                expandableContent.style.transition = '';
                expandableContent.style.width = '100%';
                expandableContent.style.boxSizing = 'border-box';
              });
            }
          }, 600); // Wait longer than the 500ms transition
        }
      };

      // Replace the original block with our rendered version
      // Don't use safelySetContent here as it might be causing the [object HTMLDivElement] issue
      // Clear the original content first
      while (block.firstChild) {
        block.removeChild(block.firstChild);
        // block.
      }
      
      // Append our rendered container
      block.appendChild(resultContainer);

      // Store the rendered block for future reference
      renderedFunctionResults.set(blockId, resultContainer);

      return true;
    } catch (e) {
      console.error('Error parsing function result:', e);
      return false;
    }
  } catch (e) {
    console.error('Error rendering function result:', e);
    return false;
  } finally {
    // Reset processing state
    isProcessingRef.current = false;
  }
};
