/**
 * Perplexity website components for MCP-SuperAssistant
 *
 * This file implements the MCP popover button for Perplexity website with toggle functionality:
 * 1. MCP ON/OFF toggle
 * 2. Auto Insert toggle
 * 3. Auto Submit toggle
 * 4. Auto Execute toggle
 */

// import React from 'react';
// import ReactDOM from 'react-dom/client';
// import { MCPPopover } from '../../components/mcpPopover/mcpPopover';
import type { AdapterConfig, SimpleSiteAdapter } from './common';
import { initializeAdapter, ToggleStateManager, MCPToggleState } from './common'; // Import from the common file

// Keep Perplexity-specific functions or overrides

// Find where to insert the MCP popover in Perplexity UI
function findPerplexityButtonInsertionPoint(): { container: Element; insertAfter: Element | null } | null {
  // Look for the radiogroup element in the top control bar
  const radioGroup = document.querySelector('div[role="radiogroup"].group.relative.isolate.flex');

  if (radioGroup) {
    // Find the parent container that contains the radiogroup
    const container = radioGroup.closest('.flex.items-center');
    if (container) {
      console.debug('[Perplexity Adapter] Found search/research toggle container, placing MCP button next to it');
      // Insert after the div wrapping the radiogroup, if possible
      const wrapperDiv = radioGroup.parentElement;
      return {
        container: container,
        insertAfter: wrapperDiv, // Insert after the radiogroup's wrapper div
      };
    }
  }

  // Fallback: Look for the main input area's action buttons container
  const actionsContainer = document.querySelector('div.flex.items-end.gap-sm'); // Adjust selector if needed
  if (actionsContainer) {
    console.debug('[Perplexity Adapter] Found actions container (fallback)');
    // Try inserting after the file upload button if it exists
    const fileUploadButton = actionsContainer.querySelector('button[aria-label*="Attach"]');
    return { container: actionsContainer, insertAfter: fileUploadButton || null };
  }

  console.warn('[Perplexity Adapter] Could not find a suitable insertion point.');
  return null;
}

// Perplexity-specific sidebar handling
function showPerplexitySidebar(adapter: SimpleSiteAdapter | null): void {
  console.debug('[Perplexity Adapter] MCP Enabled - Showing sidebar');
  // Perplexity might have a specific way to show its sidebar or related UI
  if (adapter && (adapter as any).sidebarManager?.show) {
    (adapter as any).sidebarManager.show().catch((e: any) => console.error('Error showing Perplexity sidebar:', e));
  } else if (adapter?.showSidebarWithToolOutputs) {
    // Generic fallback
    adapter.showSidebarWithToolOutputs();
  } else {
    console.warn('[Perplexity Adapter] No specific method found to show sidebar.');
  }
}

function hidePerplexitySidebar(adapter: SimpleSiteAdapter | null): void {
  console.debug('[Perplexity Adapter] MCP Disabled - Hiding sidebar');
  if (adapter && (adapter as any).sidebarManager?.hide) {
    (adapter as any).sidebarManager.hide();
  } else if (adapter?.hideSidebar) {
    // Generic fallback
    adapter.hideSidebar();
  } else {
    console.warn('[Perplexity Adapter] No specific method found to hide sidebar.');
  }
}

// Perplexity-specific URL key generation
function getPerplexityURLKey(): string {
  const currentPath = window.location.pathname;
  const isSearchPath = currentPath.includes('/search/');
  const isLibraryPath = currentPath.includes('/library/');
  const isHomePath = currentPath === '/' || currentPath === '';

  if (isSearchPath) return 'search';
  if (isLibraryPath) return 'library';
  if (isHomePath) return 'home';
  return 'generic'; // Default key
}

// Perplexity Adapter Configuration
const perplexityAdapterConfig: AdapterConfig = {
  adapterName: 'Perplexity',
  storageKeyPrefix: 'mcp-perplexity-state', // Use chrome.storage, prefix + URL key
  findButtonInsertionPoint: findPerplexityButtonInsertionPoint,
  getStorage: () => chrome.storage.local, // Perplexity uses chrome.storage.local
  getCurrentURLKey: getPerplexityURLKey, // Use Perplexity-specific key generation
  onMCPEnabled: showPerplexitySidebar,
  onMCPDisabled: hidePerplexitySidebar,
  // insertToggleButtons: customInsertFunction, // Optional: If common insertion doesn't work
  // updateUI: customUpdateUI, // Optional: If specific UI updates needed
};

// Initialize Perplexity components using the common initializer
export function initPerplexityComponents(): void {
  console.debug('Initializing Perplexity MCP components using common framework');
  const stateManager = initializeAdapter(perplexityAdapterConfig);

  // Expose manual injection for debugging (optional)
  window.injectMCPButtons = () => {
    console.debug('Manual injection for Perplexity triggered');
    const insertFn = (window as any)[`injectMCPButtons_${perplexityAdapterConfig.adapterName}`];
    if (insertFn) {
      insertFn();
    } else {
      console.warn('Manual injection function not found.');
    }
  };

  console.debug('Perplexity MCP components initialization complete.');
}

// --- Removed Code ---
// - SimpleSiteAdapter interface (moved to common)
// - Global window interface extension (handled in common or specific adapter if needed)
// - MCPToggleState interface (moved to common)
// - defaultState constant (moved to common)
// - toggleState variable (managed within common)
// - toggleStateManager object (replaced by ToggleStateManager class in common)
// - loadState/saveState functions (handled by ToggleStateManager)
// - updateButtonStates (handled by ToggleStateManager.updateUI)
// - showSidebar/hideSidebar/showSidebarWithToolOutputs (integrated via config callbacks)
// - handleAutoInsert/handleAutoInsertWithFile/handleAutoSubmit (moved to common)
// - Event listener setup (handled by setupToolExecutionListener in common)
// - insertToggleButtons (handled by common or specific config override)
// - applyLoadedState (handled by ToggleStateManager)
// - Initialization logic structure (replaced by initializeAdapter)
// - MutationObserver and interval checks (handled within initializeAdapter)
