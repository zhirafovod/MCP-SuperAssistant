/**
 * Base Site Adapter
 *
 * This file implements a base adapter class with common functionality
 * that can be extended by site-specific adapters.
 */

import type { SiteAdapter } from '../../utils/siteAdapter';
import { logMessage } from '../../utils/helpers';

export abstract class BaseAdapter implements SiteAdapter {
  abstract name: string;
  abstract hostname: string | string[];
  urlPatterns?: RegExp[];
  protected sidebarManager: any = null;
  // protected toolDetector: SimpleToolDetector = createToolDetector();

  // Abstract methods that must be implemented by site-specific adapters
  protected abstract initializeObserver(forceReset?: boolean): void;
  protected initializeSidebarManager(): void {
    // Default implementation - can be overridden by subclasses
    if (this.sidebarManager) {
      this.sidebarManager.initialize();
    }
  }

  // Abstract methods for text insertion and form submission
  abstract insertTextIntoInput(text: string): void;
  abstract triggerSubmission(): void;

  initialize(): void {
    logMessage(`Initializing ${this.name} adapter`);

    // Initialize the sidebar manager if it exists
    if (this.sidebarManager) {
      logMessage(`Initializing sidebar manager for ${this.name}`);
      this.initializeSidebarManager();
    } else {
      logMessage(`No sidebar manager found for ${this.name}`);
    }

    // Initialize the unified observer
    logMessage(`Initializing unified observer for ${this.name} elements`);
    this.initializeObserver(true);
  }

  cleanup(): void {
    logMessage(`Cleaning up ${this.name} adapter`);

    if (this.sidebarManager) {
      this.sidebarManager.destroy();
      this.sidebarManager = null;
    }
  }

  /**
   * Show the sidebar with tool outputs
   */
  showSidebarWithToolOutputs(): void {
    if (this.sidebarManager) {
      this.sidebarManager.showWithToolOutputs();
      logMessage('Showing sidebar with tool outputs');
    }
  }

  toggleSidebar(): void {
    if (this.sidebarManager) {
      if (this.sidebarManager.getIsVisible()) {
        this.sidebarManager.hide();
      } else {
        this.sidebarManager.showWithToolOutputs();
        logMessage('Showing sidebar with tool outputs');
      }
    }
  }

  updateConnectionStatus(isConnected: boolean): void {
    logMessage(`Updating ${this.name} connection status: ${isConnected}`);
    // Implement connection status update if needed
    // if (this.overlayManager) {
    //   this.overlayManager.updateConnectionStatus(isConnected);
    // }
  }

  /**
   * Force refresh the sidebar content
   * This can be called to manually refresh the sidebar when needed
   */
  refreshSidebarContent(): void {
    logMessage(`Forcing sidebar content refresh for ${this.name}`);
    if (this.sidebarManager) {
      this.sidebarManager.refreshContent();
      logMessage('Sidebar content refreshed');
    }
  }

  /**
   * Check if the site supports file upload
   * Default implementation returns false, override in site-specific adapters if supported
   */
  supportsFileUpload(): boolean {
    return false;
  }

  /**
   * Attach a file to the chat input
   * Default implementation returns a rejected promise, override in site-specific adapters if supported
   * @param file The file to attach
   */
  async attachFile(file: File): Promise<boolean> {
    logMessage(`File attachment not supported for ${this.name}`);
    return Promise.resolve(false);
  }
}
