/**
 * ChatGPT website components for MCP-SuperAssistant
 *
 * This file implements the MCP popover button for ChatGPT website with toggle functionality:
 * 1. MCP ON/OFF toggle
 * 2. Auto Insert toggle
 * 3. Auto Submit toggle
 * 4. Auto Execute toggle
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { MCPPopover } from '../../components/mcpPopover/mcpPopover';
import type { AdapterConfig, ToggleStateManager, SimpleSiteAdapter } from './common';
import {
  initializeAdapter,
  MCPToggleState,
  insertToggleButtonsCommon, // Import common inserter if needed
} from './common';

// Keep ChatGPT-specific functions or overrides

// Find where to insert the MCP popover in ChatGPT UI
function findChatGPTButtonInsertionPoint(): Element | null {
  // Try specific selectors first based on observed structure
  const specificContainer = document.querySelector('textarea + div .flex.items-center.gap-2');
  if (specificContainer) {
    console.debug('[ChatGPT Adapter] Found specific button container (textarea + div .flex...)');
    return specificContainer;
  }

  const buttonContainer = document.querySelector('.flex.items-center.gap-2.overflow-x-auto');
  if (buttonContainer) {
    console.debug('[ChatGPT Adapter] Found primary button container (.flex.items-center.gap-2.overflow-x-auto)');
    return buttonContainer;
  }

  // Try alternative selectors
  const altButtonContainer = document.querySelector('.max-xs\\:gap-1.flex.items-center.gap-2');
  if (altButtonContainer) {
    console.debug('[ChatGPT Adapter] Found alternative button container (.max-xs...flex.items-center.gap-2)');
    return altButtonContainer;
  }

  // Try parent of tools button as fallback
  const toolsButton = document.querySelector('[aria-label*="tool"]'); // More generic label search
  if (toolsButton && toolsButton.parentElement) {
    console.debug('[ChatGPT Adapter] Found tools button parent as fallback');
    return toolsButton.parentElement;
  }

  console.warn('[ChatGPT Adapter] Could not find any suitable container for MCP button');
  return null;
}

// Custom insertion logic for ChatGPT to place the button correctly (e.g., as the third button)
function insertChatGPTButtons(config: AdapterConfig, stateManager: ToggleStateManager): void {
  console.debug(`[${config.adapterName}] Inserting MCP popover button (ChatGPT specific)`);

  if (document.getElementById('mcp-popover-container')) {
    console.debug(`[${config.adapterName}] MCP popover already exists, applying state.`);
    stateManager.applyLoadedState();
    return;
  }

  // Use the specific finder function - note it returns Element | null, not the object structure
  const container = config.findButtonInsertionPoint() as Element | null;
  if (!container) {
    console.debug(`[${config.adapterName}] Could not find insertion point, retrying...`);
    setTimeout(() => insertChatGPTButtons(config, stateManager), 1000);
    return;
  }

  try {
    const reactContainer = document.createElement('div');
    reactContainer.id = 'mcp-popover-container';
    reactContainer.style.display = 'inline-block';
    reactContainer.className = 'mcp-popover-wrapper'; // Add class if needed
    reactContainer.style.margin = '0 4px'; // Consistent spacing

    // Ensure container is still in the DOM
    if (!document.body.contains(container)) {
      console.debug(`[${config.adapterName}] Insertion container is no longer in the DOM, retrying...`);
      setTimeout(() => insertChatGPTButtons(config, stateManager), 1000);
      return;
    }

    // ChatGPT Specific: Create a wrapper div that matches other buttons' style/structure if needed
    const buttonWrapper = document.createElement('div');
    // Add any necessary classes or styles to buttonWrapper if ChatGPT requires it
    // buttonWrapper.className = 'some-chatgpt-button-wrapper-class';
    buttonWrapper.style.viewTransitionName = 'var(--vt-composer-mcp-action)'; // Example style seen before

    // Attempt to insert as the third button (index 2)
    const children = Array.from(container.children);
    if (children.length >= 2) {
      // Insert before the element at index 2 (which is the third element)
      container.insertBefore(buttonWrapper, children[2]);
      console.debug(`[${config.adapterName}] Inserted wrapper before the third button.`);
    } else {
      // Fallback: Append if there are fewer than 2 buttons
      container.appendChild(buttonWrapper);
      console.debug(`[${config.adapterName}] Appended wrapper as fewer than 2 buttons exist.`);
    }

    // Add the React container inside the wrapper
    buttonWrapper.appendChild(reactContainer);

    // Render the React MCPPopover using the common method's approach
    ReactDOM.createRoot(reactContainer).render(
      React.createElement(MCPPopover, {
        toggleStateManager: {
          getState: stateManager.getState.bind(stateManager),
          setMCPEnabled: stateManager.setMCPEnabled.bind(stateManager),
          setAutoInsert: stateManager.setAutoInsert.bind(stateManager),
          setAutoSubmit: stateManager.setAutoSubmit.bind(stateManager),
          setAutoExecute: stateManager.setAutoExecute.bind(stateManager),
          updateUI: stateManager.updateUI.bind(stateManager),
        },
      }),
    );

    console.debug(`[${config.adapterName}] MCP popover rendered successfully.`);
    stateManager.applyLoadedState();
  } catch (error) {
    console.error(`[${config.adapterName}] Error inserting MCP popover:`, error);
    // Fallback to common inserter? Or just retry specific one?
    // setTimeout(() => insertChatGPTButtons(config, stateManager), 2000);
  }
}

// ChatGPT-specific sidebar handling
function showChatGPTSidebar(adapter: SimpleSiteAdapter | null): void {
  console.debug('[ChatGPT Adapter] MCP Enabled - Showing sidebar');
  if (adapter?.showSidebarWithToolOutputs) {
    adapter.showSidebarWithToolOutputs();
  } else if (adapter?.toggleSidebar) {
    adapter.toggleSidebar(); // Fallback
  } else {
    console.warn('[ChatGPT Adapter] No method found to show sidebar.');
  }
}

function hideChatGPTSidebar(adapter: SimpleSiteAdapter | null): void {
  console.debug('[ChatGPT Adapter] MCP Disabled - Hiding sidebar');
  if (adapter?.hideSidebar) {
    adapter.hideSidebar();
  } else if (adapter?.sidebarManager?.hide) {
    adapter.sidebarManager.hide();
  } else if (adapter?.toggleSidebar) {
    adapter.toggleSidebar(); // Fallback
  } else {
    console.warn('[ChatGPT Adapter] No method found to hide sidebar.');
  }
}

// ChatGPT-specific URL key generation
function getChatGPTURLKey(): string {
  const url = window.location.href;
  // Example: Use 'chatgpt_chat' for main chat, maybe different for settings etc.
  if (url.includes('/c/')) {
    // If it's a specific chat URL
    // Could potentially use the chat ID, but might create too many keys.
    // Let's stick to a general key for chats.
    return 'chatgpt_chat';
  }
  // Default key for other ChatGPT pages (e.g., main page without /c/)
  if (url.includes('chat.openai.com')) {
    return 'chatgpt_main';
  }
  // Fallback generic key
  return 'chatgpt_default';
}

// ChatGPT Adapter Configuration
const chatGPTAdapterConfig: AdapterConfig = {
  adapterName: 'ChatGPT',
  storageKeyPrefix: 'mcp-chatgpt-state', // Uses localStorage
  findButtonInsertionPoint: findChatGPTButtonInsertionPoint, // Use the specific finder
  insertToggleButtons: insertChatGPTButtons, // Use the specific inserter
  getStorage: () => localStorage, // ChatGPT uses localStorage
  getCurrentURLKey: getChatGPTURLKey, // Use specific URL key logic
  onMCPEnabled: showChatGPTSidebar,
  onMCPDisabled: hideChatGPTSidebar,
};

// Initialize ChatGPT components using the common initializer
export function initChatGPTComponents(): void {
  console.debug('Initializing ChatGPT components using common framework');
  const stateManager = initializeAdapter(chatGPTAdapterConfig);

  // Expose manual injection for debugging (optional)
  window.injectMCPButtons = () => {
    console.debug('Manual injection for ChatGPT triggered');
    const insertFn = (window as any)[`injectMCPButtons_${chatGPTAdapterConfig.adapterName}`];
    if (insertFn) {
      insertFn();
    } else {
      // Fallback to calling the specific insert function directly if global not set
      // Need the stateManager instance, which isn't easily available here.
      // Re-running init might be an option, or just rely on the auto-retry logic.
      console.warn('Manual injection function not found. Re-initialization might be needed.');
      // insertChatGPTButtons(chatGPTAdapterConfig, stateManager); // stateManager not available here
    }
  };

  console.debug('ChatGPT components initialization complete.');
}

// --- Removed Code ---
// - SimpleSiteAdapter interface (moved to common)
// - Global window interface extension (handled in common)
// - MCPToggleState interface (moved to common)
// - defaultState constant (moved to common)
// - toggleState variable (managed within common)
// - toggleStateManager object (replaced by ToggleStateManager class in common)
// - loadState/saveState functions (handled by ToggleStateManager)
// - updateButtonStates (handled by ToggleStateManager.updateUI)
// - showSidebar/hideSidebar/showSidebarWithToolOutputs (integrated via config callbacks)
// - handleAutoInsert/handleAutoInsertWithFile/handleAutoSubmit (moved to common)
// - Event listener setup (handled by setupToolExecutionListener in common)
// - applyLoadedState (handled by ToggleStateManager)
// - Initialization logic structure (replaced by initializeAdapter)
// - MutationObserver and interval checks (handled within initializeAdapter)
