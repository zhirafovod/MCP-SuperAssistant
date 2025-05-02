/**
 * ChatGPT Adapter
 *
 * This file implements the site adapter for chatgpt.com
 */

import { BaseAdapter } from './common';
import { logMessage } from '../utils/helpers';
import { insertToolResultToChatInput, attachFileToChatInput, submitChatInput } from '../components/websites/chatgpt';
import { SidebarManager } from '../components/sidebar';
import { initChatGPTComponents } from './adaptercomponents';
export class ChatGptAdapter extends BaseAdapter {
  name = 'ChatGPT';
  hostname = ['chat.openai.com', 'chatgpt.com'];

  // Properties to track navigation
  private lastUrl: string = '';
  private urlCheckInterval: number | null = null;

  constructor() {
    super();
    // Create the sidebar manager instance
    this.sidebarManager = SidebarManager.getInstance('chatgpt');
    logMessage('Created ChatGPT sidebar manager instance');
    // initChatGPTComponents();
  }

  protected initializeSidebarManager(): void {
    this.sidebarManager.initialize();
  }

  protected initializeObserver(forceReset: boolean = false): void {
    // super.initializeObserver(forceReset);
    initChatGPTComponents();

    // Start URL checking to handle navigation within AiStudio
    if (!this.urlCheckInterval) {
      this.lastUrl = window.location.href;
      this.urlCheckInterval = window.setInterval(() => {
        const currentUrl = window.location.href;

        if (currentUrl !== this.lastUrl) {
          logMessage(`URL changed from ${this.lastUrl} to ${currentUrl}`);
          this.lastUrl = currentUrl;

          initChatGPTComponents();
          // Check if we should show or hide the sidebar based on URL
          this.checkCurrentUrl();
        }
      }, 1000); // Check every second
    }
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
   * Insert text into the ChatGPT input field
   * @param text Text to insert
   */
  insertTextIntoInput(text: string): void {
    insertToolResultToChatInput(text);
    logMessage(`Inserted text into ChatGPT input: ${text.substring(0, 20)}...`);
  }

  /**
   * Trigger submission of the ChatGPT input form
   */
  triggerSubmission(): void {
    // Use the function to submit the form
    submitChatInput()
      .then((success: boolean) => {
        logMessage(`Triggered ChatGPT form submission: ${success ? 'success' : 'failed'}`);
      })
      .catch((error: Error) => {
        logMessage(`Error triggering ChatGPT form submission: ${error}`);
      });
  }

  /**
   * Check if ChatGPT supports file upload
   * @returns true if file upload is supported
   */
  supportsFileUpload(): boolean {
    return true;
  }

  /**
   * Attach a file to the ChatGPT input
   * @param file The file to attach
   * @returns Promise that resolves to true if successful
   */
  async attachFile(file: File): Promise<boolean> {
    try {
      const result = await attachFileToChatInput(file);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logMessage(`Error in adapter when attaching file to ChatGPT input: ${errorMessage}`);
      console.error('Error in adapter when attaching file to ChatGPT input:', error);
      return false;
    }
  }

  /**
   * Force a full document scan for tool commands
   * This is useful when we suspect tool commands might have been missed
   */
  public forceFullScan(): void {
    logMessage('Forcing full document scan for ChatGPT');
  }

  /**
   * Check the current URL and show/hide sidebar accordingly
   */
  private checkCurrentUrl(): void {
    const currentUrl = window.location.href;
    logMessage(`Checking current Chatgpt URL: ${currentUrl}`);

    // For AiStudio, we want to show the sidebar on all pages
    // You can customize this with specific URL patterns if needed
    if (this.sidebarManager && !this.sidebarManager.getIsVisible()) {
      logMessage('Showing sidebar for Chatgpt URL');
      this.sidebarManager.showWithToolOutputs();
    }
  }
}
