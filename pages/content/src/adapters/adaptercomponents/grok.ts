/**
 * Grok website components for MCP-SuperAssistant
 *
 * This file implements the toggle buttons for MCP functionality on the Grok website:
 * 1. MCP ON/OFF toggle
 * 2. Auto Insert toggle
 * 3. Auto Submit toggle
 * 4. Auto Execute toggle
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { MCPPopover } from '../../components/mcpPopover/mcpPopover';
import type {
  AdapterConfig, // Import if needed for type hints, but instance is created by initializeAdapter
  SimpleSiteAdapter,
} from './common';
import {
  initializeAdapter,
  ToggleStateManager,
  MCPToggleState, // Import if needed
} from './common'; // Import from the common file

// Keep Grok-specific functions or overrides
function findGrokButtonInsertionPoint(): { container: Element; insertAfter: Element | null } | null {
  // Find the Think button in the bottom control bar
  const thinkButton = document.querySelector('button[aria-label="Think"]');
  if (thinkButton && thinkButton.parentElement) {
    console.debug('[Grok Adapter] Found insertion point relative to Think button');
    // Insert after the parent of the think button if it's a simple container,
    // or adjust based on actual structure. Let's assume parent is the container.
    return { container: thinkButton.parentElement, insertAfter: thinkButton };
  }

  // Fallback: Try to find the input area container
  const inputArea = document.querySelector('.query-bar'); // Adjust selector if needed
  if (inputArea) {
    console.debug('[Grok Adapter] Found insertion point in query-bar (fallback)');
    // Find a suitable element to insert after, or append to the end
    const sendButton = inputArea.querySelector('button[aria-label*="Send"]'); // Example
    return { container: inputArea, insertAfter: sendButton || null };
  }

  // Another fallback: Look for the main chat actions container
  const chatAreaActions = document.querySelector('.absolute.bottom-0 .flex'); // Adjust selector
  if (chatAreaActions) {
    console.debug('[Grok Adapter] Found insertion point in chat area actions (fallback 2)');
    return { container: chatAreaActions, insertAfter: null }; // Append to end
  }

  console.warn('[Grok Adapter] Could not find a suitable insertion point.');
  return null;
}

// Grok-specific sidebar handling (if different from common)
function showGrokSidebar(adapter: SimpleSiteAdapter | null): void {
  console.debug('[Grok Adapter] MCP Enabled - Showing sidebar');
  if (adapter?.showSidebarWithToolOutputs) {
    adapter.showSidebarWithToolOutputs();
  } else if (adapter?.toggleSidebar) {
    adapter.toggleSidebar(); // Fallback
  } else {
    console.warn('[Grok Adapter] No method found to show sidebar.');
  }
}

function hideGrokSidebar(adapter: SimpleSiteAdapter | null): void {
  console.debug('[Grok Adapter] MCP Disabled - Hiding sidebar');
  if (adapter?.hideSidebar) {
    adapter.hideSidebar();
  } else if (adapter?.sidebarManager?.hide) {
    adapter.sidebarManager.hide();
  } else if (adapter?.toggleSidebar) {
    adapter.toggleSidebar(); // Fallback (might show if already hidden)
  } else {
    console.warn('[Grok Adapter] No method found to hide sidebar.');
  }
}

// Grok-specific URL key generation (if different from default)
function getGrokURLKey(): string {
  // Grok might not need complex keys, maybe just a constant
  return 'grok_chat'; // Or derive from URL if needed
}

// Grok Adapter Configuration
const grokAdapterConfig: AdapterConfig = {
  adapterName: 'Grok',
  storageKeyPrefix: 'mcp-grok-state', // Use chrome.storage, so prefix is enough
  findButtonInsertionPoint: findGrokButtonInsertionPoint,
  getStorage: () => chrome.storage.local, // Grok uses chrome.storage.local
  getCurrentURLKey: getGrokURLKey, // Use Grok-specific key generation
  onMCPEnabled: showGrokSidebar,
  onMCPDisabled: hideGrokSidebar,
  // insertToggleButtons: customInsertFunction, // Optional: If common insertion doesn't work
  // updateUI: customUpdateUI, // Optional: If specific UI updates needed beyond popover
};

// Initialize Grok components using the common initializer
export function initGrokComponents(): void {
  console.debug('Initializing Grok MCP components using common framework');
  // The initializeAdapter function handles state loading, button insertion, listeners etc.
  const stateManager = initializeAdapter(grokAdapterConfig);

  // Expose manual injection for debugging (optional, uses adapter name)
  window.injectMCPButtons = () => {
    console.debug('Manual injection for Grok triggered');
    // Use the specific function exposed by initializeAdapter if needed, or re-call init
    const insertFn = (window as any)[`injectMCPButtons_${grokAdapterConfig.adapterName}`];
    if (insertFn) {
      insertFn();
    } else {
      console.warn('Manual injection function not found.');
    }
  };

  console.debug('Grok MCP components initialization complete.');
}

// --- Removed Code ---
// - MCPToggleState interface (moved to common)
// - defaultState constant (moved to common)
// - toggleState variable (managed within common, exposed globally)
// - toggleStateManager object (replaced by ToggleStateManager class in common)
// - loadState/saveState functions (handled by ToggleStateManager)
// - updateButtonStates (handled by ToggleStateManager.updateUI)
// - showSidebar/hideSidebar/showSidebarWithToolOutputs (integrated via config callbacks)
// - handleAutoInsert/handleAutoInsertWithFile/handleAutoSubmit (moved to common)
// - Event listener setup (handled by setupToolExecutionListener in common)
// - insertToggleButtons (handled by common or specific config override)
// - applyLoadedState (handled by ToggleStateManager)
// - Initialization logic structure (replaced by initializeAdapter)
