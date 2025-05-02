/**
 * AiStudio Adapter
 *
 * This file implements the site adapter for aistudio.google.com
 */

import { BaseAdapter } from './common';
import { logMessage } from '../utils/helpers';
import { insertToolResultToChatInput } from '../components/websites/aistudio';
import { SidebarManager } from '../components/sidebar';
import { attachFileToChatInput, submitChatInput } from '../components/websites/aistudio/chatInputHandler';
import { initAIStudioComponents } from './adaptercomponents';

export class AiStudioAdapter extends BaseAdapter {
  name = 'AiStudio';
  hostname = ['aistudio.google.com'];

  // Property to store the last URL
  private lastUrl: string = '';
  // Property to store the interval ID
  private urlCheckInterval: number | null = null;

  constructor() {
    super();
    // Create the sidebar manager instance
    this.sidebarManager = SidebarManager.getInstance('aistudio');
    logMessage('Created AiStudio sidebar manager instance');
  }

  protected initializeSidebarManager(): void {
    this.sidebarManager.initialize();
  }

  protected initializeObserver(forceReset: boolean = false): void {
    // Check the current URL immediately
    // this.checkCurrentUrl();

    // Initialize AI Studio components
    initAIStudioComponents();

    // Start URL checking to handle navigation within AiStudio
    // if (!this.urlCheckInterval) {
    //   this.lastUrl = window.location.href;
    //   this.urlCheckInterval = window.setInterval(() => {
    //     const currentUrl = window.location.href;

    //     if (currentUrl !== this.lastUrl) {
    //       logMessage(`URL changed from ${this.lastUrl} to ${currentUrl}`);
    //       this.lastUrl = currentUrl;

    //       initAIStudioComponents();
    //       // Check if we should show or hide the sidebar based on URL
    //       this.checkCurrentUrl();
    //     }
    //   }, 1000); // Check every second
    // }
  }

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
   * Insert text into the AiStudio input field
   * @param text Text to insert
   */
  insertTextIntoInput(text: string): void {
    insertToolResultToChatInput(text);
    logMessage(`Inserted text into AiStudio input: ${text.substring(0, 20)}...`);
  }

  /**
   * Trigger submission of the AiStudio input form
   */
  triggerSubmission(): void {
    // Use the function to submit the form
    submitChatInput()
      .then((success: boolean) => {
        logMessage(`Triggered AiStudio form submission: ${success ? 'success' : 'failed'}`);
      })
      .catch((error: Error) => {
        logMessage(`Error triggering AiStudio form submission: ${error}`);
      });
  }

  /**
   * Check if AiStudio supports file upload
   * @returns true if file upload is supported
   */
  supportsFileUpload(): boolean {
    return true;
  }

  /**
   * Attach a file to the AiStudio input
   * @param file The file to attach
   * @returns Promise that resolves to true if successful
   */
  async attachFile(file: File): Promise<boolean> {
    try {
      const result = await attachFileToChatInput(file);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logMessage(`Error in adapter when attaching file to AiStudio input: ${errorMessage}`);
      console.error('Error in adapter when attaching file to AiStudio input:', error);
      return false;
    }
  }

  /**
   * Check the current URL and show/hide sidebar accordingly
   */
  private checkCurrentUrl(): void {
    const currentUrl = window.location.href;
    logMessage(`Checking current AiStudio URL: ${currentUrl}`);

    // For AiStudio, we want to show the sidebar on all pages
    // You can customize this with specific URL patterns if needed
    if (this.sidebarManager && !this.sidebarManager.getIsVisible()) {
      logMessage('Showing sidebar for AiStudio URL');
      this.sidebarManager.showWithToolOutputs();
    }
  }
}
