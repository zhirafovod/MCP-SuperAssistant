/**
 * Perplexity Adapter
 *
 * This file implements the site adapter for perplexity.ai
 *
 * Available functionalities when accessed globally:
 *
 * 1. insertTextIntoInput(text: string): void
 *    - Inserts text into the Perplexity chat input field
 *
 * 2. triggerSubmission(): void
 *    - Submits the chat input form
 *
 * 3. supportsFileUpload(): boolean
 *    - Checks if file upload is supported in the current context
 *
 * 4. attachFile(file: File): Promise<boolean>
 *    - Attaches a file to the chat input
 *    - Returns a Promise resolving to true if successful
 *
 * 5. forceFullScan(): void
 *    - Forces a full document scan for tool commands
 *
 * 6. toggleSidebar(): void
 *    - Shows or hides the sidebar (inherited from BaseAdapter)
 *
 * 7. showSidebarWithToolOutputs(): void
 *    - Shows the sidebar with tool outputs (inherited from BaseAdapter)
 *
 * Example usage when accessing globally:
 * ```typescript
 * // Get the current adapter
 * const adapter = window.mcpAdapter;
 *
 * // Check if it's the Perplexity adapter
 * if (adapter && adapter.name === 'Perplexity') {
 *   // Insert text into the chat input
 *   adapter.insertTextIntoInput('Hello from MCP-SuperAssistant!');
 *
 *   // Submit the form
 *   adapter.triggerSubmission();
 *
 *   // Check if file upload is supported
 *   if (adapter.supportsFileUpload()) {
 *     // Create a file object (e.g., from a file input)
 *     const fileInput = document.getElementById('fileInput') as HTMLInputElement;
 *     const file = fileInput.files?.[0];
 *
 *     // Attach the file if available
 *     if (file) {
 *       adapter.attachFile(file)
 *         .then(success => console.debug(`File attachment ${success ? 'succeeded' : 'failed'}`));
 *     }
 *   }
 *
 *   // Toggle the sidebar
 *   adapter.toggleSidebar();
 * }
 * ```
 */

import { BaseAdapter } from './common';
import { logMessage } from '../utils/helpers';
import { insertToolResultToChatInput } from '../components/websites/perplexity';
import { SidebarManager } from '../components/sidebar';
import { attachFileToChatInput, submitChatInput } from '../components/websites/perplexity/chatInputHandler';
import { initPerplexityComponents } from './adaptercomponents';

export class PerplexityAdapter extends BaseAdapter {
  name = 'Perplexity';
  hostname = ['perplexity.ai'];

  // Property to store the last URL
  private lastUrl: string = '';
  // Property to store the interval ID
  private urlCheckInterval: number | null = null;

  constructor() {
    super();
    // Create the sidebar manager instance
    this.sidebarManager = SidebarManager.getInstance('perplexity');
    logMessage('Created Perplexity sidebar manager instance');
  }

  protected initializeSidebarManager(): void {
    this.sidebarManager.initialize();
  }

  protected initializeObserver(forceReset: boolean = false): void {
    // Check the current URL immediately
    // this.checkCurrentUrl();

    // Initialize Perplexity UI components (toggle buttons)
    initPerplexityComponents();

    // Start URL checking to handle navigation within Perplexity
    // if (!this.urlCheckInterval) {
    //   this.lastUrl = window.location.href;
    //   this.urlCheckInterval = window.setInterval(() => {
    //     const currentUrl = window.location.href;

    //     if (currentUrl !== this.lastUrl) {
    //       logMessage(`URL changed from ${this.lastUrl} to ${currentUrl}`);
    //       this.lastUrl = currentUrl;
    //       initPerplexityComponents();
    //       // Check if we should show or hide the sidebar based on URL
    //       const excludedUrls = [
    //         'https://www.perplexity.ai/abcd',
    //         // 'https://www.perplexity.ai/library'
    //       ];

    //       const includedPatterns = [
    //         /^https:\/\/www\.perplexity\.ai\/search\/.*/
    //       ];

    //       // Check if current URL is excluded
    //       const isExcluded = excludedUrls.some(url => currentUrl === url);

    //       // Check if current URL matches included patterns
    //       const isIncluded = includedPatterns.some(pattern => pattern.test(currentUrl));

    //       if (isExcluded && !isIncluded) {
    //         // Keep sidebar visible but clear detected tools for excluded URLs
    //         if (this.sidebarManager) {
    //           logMessage('On excluded Perplexity URL, keeping sidebar visible but clearing detected tools');
    //           // Make sure sidebar is visible
    //           if (!this.sidebarManager.getIsVisible()) {
    //             this.sidebarManager.show();
    //           }
    //           // Tools will be cleared automatically by mcptooldetect.ts
    //         }
    //       } else {
    //         // Show sidebar for included URLs
    //         if (this.sidebarManager && !this.sidebarManager.getIsVisible()) {
    //           logMessage('Showing sidebar for included Perplexity URL');
    //           this.sidebarManager.showWithToolOutputs();
    //         }
    //       }
    //     }
    //   }, 1000); // Check every second
    // }
  }

  cleanup(): void {
    // Clear the URL check interval
    if (this.urlCheckInterval) {
      window.clearInterval(this.urlCheckInterval);
      this.urlCheckInterval = null;
    }

    // Call the base implementation
    super.cleanup();
  }

  /**
   * Insert text into the Perplexity input field
   * @param text Text to insert
   */
  insertTextIntoInput(text: string): void {
    insertToolResultToChatInput(text);
    logMessage(`Inserted text into Perplexity input: ${text.substring(0, 20)}...`);
  }

  /**
   * Trigger submission of the Perplexity input form
   */
  triggerSubmission(): void {
    // Use the function to submit the form
    submitChatInput()
      .then((success: boolean) => {
        logMessage(`Triggered Perplexity form submission: ${success ? 'success' : 'failed'}`);
      })
      .catch((error: Error) => {
        logMessage(`Error triggering Perplexity form submission: ${error}`);
      });
  }

  /**
   * Check if Perplexity supports file upload
   * @returns true if file upload is supported
   */
  supportsFileUpload(): boolean {
    return true;
  }

  /**
   * Attach a file to the Perplexity input
   * @param file The file to attach
   * @returns Promise that resolves to true if successful
   */
  async attachFile(file: File): Promise<boolean> {
    try {
      const result = await attachFileToChatInput(file);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logMessage(`Error in adapter when attaching file to Perplexity input: ${errorMessage}`);
      console.error('Error in adapter when attaching file to Perplexity input:', error);
      return false;
    }
  }

  /**
   * Force a full document scan for tool commands
   * This is useful when we suspect tool commands might have been missed
   */
  public forceFullScan(): void {
    logMessage('Forcing full document scan for Perplexity');
  }

  /**
   * Check the current URL and show/hide sidebar accordingly
   */
  private checkCurrentUrl(): void {
    const currentUrl = window.location.href;
    logMessage(`Checking current Perplexity URL: ${currentUrl}`);

    // Check if we should show or hide the sidebar based on URL
    const excludedUrls = ['https://www.perplexity.ai/', 'https://www.perplexity.ai/library'];

    const includedPatterns = [/^https:\/\/www\.perplexity\.ai\/search\/.*/];

    // Check if current URL is excluded
    const isExcluded = excludedUrls.some(url => currentUrl === url);

    // Check if current URL matches included patterns
    const isIncluded = includedPatterns.some(pattern => pattern.test(currentUrl));

    if (isExcluded && !isIncluded) {
      // Keep sidebar visible but clear detected tools for excluded URLs
      if (this.sidebarManager) {
        logMessage('On excluded Perplexity URL, keeping sidebar visible but clearing detected tools');
        // Make sure sidebar is visible
        if (!this.sidebarManager.getIsVisible()) {
          this.sidebarManager.show();
        }
        // Tools will be cleared automatically by mcptooldetect.ts
      }
    } else {
      // Show sidebar for included URLs
      if (this.sidebarManager && !this.sidebarManager.getIsVisible()) {
        logMessage('Showing sidebar for included Perplexity URL');
        this.sidebarManager.showWithToolOutputs();
      }
    }
  }

  //   /**
  //    * Handle auto insert of a tool result into the input.
  //    * @param text Text to insert when auto insert is enabled.
  //    */
  //   public handleAutoInsert(text: string): void {
  //     handlePerplexityAutoInsert(text);
  //   }

  //   /**
  //    * Handle auto submit of the input after a tool execution.
  //    */
  //   public handleAutoSubmit(): void {
  //     handlePerplexityAutoSubmit();
  //   }
}
