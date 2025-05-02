/**
 * ChatGPT Adapter
 *
 * This file implements the site adapter for openrouter.ai
 */

import { BaseAdapter } from './common';
import { logMessage } from '../utils/helpers';
import { insertToolResultToChatInput, attachFileToChatInput, submitChatInput } from '../components/websites/openrouter';
import { SidebarManager } from '../components/sidebar';
import { initOpenRouterComponents } from './adaptercomponents/openrouter';

/**
 * OpenRouter Adapter
 */
export class OpenRouterAdapter extends BaseAdapter {
  name = 'OpenRouter';
  hostname = ['openrouter.ai'];

  // Properties to track navigation
  private lastUrl: string = '';
  private urlCheckInterval: number | null = null;

  constructor() {
    super();
    // Create the sidebar manager instance
    this.sidebarManager = SidebarManager.getInstance('openrouter');
    logMessage('Created OpenRouter sidebar manager instance');
    initOpenRouterComponents();
  }

  protected initializeSidebarManager(): void {
    this.sidebarManager.initialize();
  }

  protected initializeObserver(forceReset: boolean = false): void {}

  cleanup(): void {
    // Clear interval for URL checking
    if (this.urlCheckInterval) {
      window.clearInterval(this.urlCheckInterval);
      this.urlCheckInterval = null;
    }

    // Call the parent cleanup method
    super.cleanup();
  }

  /**
   * Insert text into the OpenRouter input field
   * @param text Text to insert
   */
  insertTextIntoInput(text: string): void {
    insertToolResultToChatInput(text);
    logMessage(`Inserted text into OpenRouter input: ${text.substring(0, 20)}...`);
  }

  /**
   * Trigger submission of the OpenRouter input form
   */
  triggerSubmission(): void {
    // Use the function to submit the form
    submitChatInput()
      .then((success: boolean) => {
        logMessage(`Triggered OpenRouter form submission: ${success ? 'success' : 'failed'}`);
      })
      .catch((error: Error) => {
        logMessage(`Error triggering OpenRouter form submission: ${error}`);
      });
  }

  /**
   * Check if OpenRouter supports file upload
   * @returns true if file upload is supported
   */
  supportsFileUpload(): boolean {
    return true;
  }

  /**
   * Attach a file to the OpenRouter input
   * @param file The file to attach
   * @returns Promise that resolves to true if successful
   */
  async attachFile(file: File): Promise<boolean> {
    try {
      const result = await attachFileToChatInput(file);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logMessage(`Error in adapter when attaching file to OpenRouter input: ${errorMessage}`);
      console.error('Error in adapter when attaching file to OpenRouter input:', error);
      return false;
    }
  }

  /**
   * Force a full document scan for tool commands
   * This is useful when we suspect tool commands might have been missed
   */
  public forceFullScan(): void {
    logMessage('Forcing full document scan for OpenRouter');
  }
}
