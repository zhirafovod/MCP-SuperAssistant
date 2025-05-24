import type React from 'react';
import type { SiteType } from './base/BaseSidebarManager';
import { BaseSidebarManager } from './base/BaseSidebarManager';
import { logMessage } from '@src/utils/helpers';
import Sidebar from './Sidebar';
import { getSidebarPreferences } from '@src/utils/storage';

// Declare a global Window interface extension to include activeSidebarManager property
declare global {
  interface Window {
    activeSidebarManager?: SidebarManager;
  }
}

/**
 * SidebarManager is a concrete implementation of BaseSidebarManager
 * that can be used for both Perplexity and ChatGPT.
 */
export class SidebarManager extends BaseSidebarManager {
  private static perplexityInstance: SidebarManager | null = null;
  private static chatgptInstance: SidebarManager | null = null;
  private static grokInstance: SidebarManager | null = null;
  private static geminiInstance: SidebarManager | null = null;
  private static aistudioInstance: SidebarManager | null = null;
  private static openrouterInstance: SidebarManager | null = null;
  private static deepseekInstance: SidebarManager | null = null;
  private static kagiInstance: SidebarManager | null = null;
  private static t3chatInstance: SidebarManager | null = null;
  private lastToolOutputsHash: string = '';
  private lastMcpToolsHash: string = '';
  private isFirstLoad: boolean = true;

  private constructor(siteType: SiteType) {
    super(siteType);

    // Store reference to current instance in window for external access
    window.activeSidebarManager = this;

    // Add event listeners
    // window.addEventListener('mcpToolsUpdated', this.handleToolsUpdated);

    // // Add a periodic refresh to catch any updates that might be missed
    // this.refreshInterval = setInterval(() => {
    //   if (this._isVisible) {
    //     this.refreshContent();
    //   }
    // }, 5000);
  }

  /**
   * Get the singleton instance of the SidebarManager for the specified site
   */
  public static getInstance(siteType: SiteType): SidebarManager {
    switch (siteType) {
      case 'perplexity':
        if (!SidebarManager.perplexityInstance) {
          SidebarManager.perplexityInstance = new SidebarManager(siteType);
        }
        return SidebarManager.perplexityInstance;
      case 'aistudio':
        if (!SidebarManager.aistudioInstance) {
          SidebarManager.aistudioInstance = new SidebarManager(siteType);
        }
        return SidebarManager.aistudioInstance;
      case 'chatgpt':
        if (!SidebarManager.chatgptInstance) {
          SidebarManager.chatgptInstance = new SidebarManager(siteType);
        }
        return SidebarManager.chatgptInstance;
      case 'grok':
        if (!SidebarManager.grokInstance) {
          SidebarManager.grokInstance = new SidebarManager(siteType);
        }
        return SidebarManager.grokInstance;
      case 'gemini':
        if (!SidebarManager.geminiInstance) {
          SidebarManager.geminiInstance = new SidebarManager(siteType);
        }
        return SidebarManager.geminiInstance;
      case 'openrouter':
        if (!SidebarManager.openrouterInstance) {
          SidebarManager.openrouterInstance = new SidebarManager(siteType);
        }
        return SidebarManager.openrouterInstance;
      case 'deepseek':
        if (!SidebarManager.deepseekInstance) {
          SidebarManager.deepseekInstance = new SidebarManager(siteType);
        }
        return SidebarManager.deepseekInstance;
      case 'kagi':
        if (!SidebarManager.kagiInstance) {
          SidebarManager.kagiInstance = new SidebarManager(siteType);
        }
        return SidebarManager.kagiInstance;
      case 't3chat':
        if (!SidebarManager.t3chatInstance) {
          SidebarManager.t3chatInstance = new SidebarManager(siteType);
        }
        return SidebarManager.t3chatInstance;
      default:
        // For any unexpected site type, create and return a new instance
        logMessage(`Creating new SidebarManager for unknown site type: ${siteType}`);
        return new SidebarManager(siteType);
    }
  }

  /**
   * Create sidebar content
   */
  protected createSidebarContent(): React.ReactNode {
    return <Sidebar />;
  }

  /**
   * Show the sidebar with tool outputs - Always render immediately
   */
  public showWithToolOutputs(): void {
    // Always use immediate rendering for consistent loading
    logMessage('[SidebarManager] Showing sidebar with immediate rendering');

    // Initialize and show immediately
    this.initialize()
      .then(() => {
        // Make sure sidebar is visible immediately after initialization
        if (this.shadowHost) {
          this.shadowHost.style.display = 'block';
          this.shadowHost.style.opacity = '1';
          this.shadowHost.classList.add('initialized');
        }
        this._isVisible = true;
        this.render();
        logMessage('[SidebarManager] Sidebar shown successfully');
      })
      .catch(error => {
        logMessage(
          `[SidebarManager] Error during initialization: ${error instanceof Error ? error.message : String(error)}`,
        );
        // Even if initialization fails, try to show the sidebar
        try {
          this.forceVisibility();
          this.render();
          logMessage('[SidebarManager] Sidebar shown with force visibility after initialization error');
        } catch (forceError) {
          logMessage(
            `[SidebarManager] Even force visibility failed: ${forceError instanceof Error ? forceError.message : String(forceError)}`,
          );
        }
      });

    // Mark as no longer first load regardless of success/failure
    this.isFirstLoad = false;
  }

  /**
   * Get initialization status
   * @returns Whether the sidebar has been initialized
   */
  public getIsInitialized(): boolean {
    return !this.isFirstLoad;
  }

  /**
   * Initialize the sidebar in collapsed state on first load,
   * then expand it if previously expanded
   */
  private async initializeCollapsedState(): Promise<void> {
    this.isFirstLoad = false;

    // First show the sidebar in a guaranteed collapsed state
    await this.initialize();

    // Check stored preferences to determine if sidebar should be expanded
    try {
      const preferences = await getSidebarPreferences();
      const wasMinimized = preferences.isMinimized ?? false;
      const isPushMode = preferences.isPushMode ?? false;
      const sidebarWidth = preferences.sidebarWidth || 320;

      // Show sidebar initially in minimized state
      if (this.shadowHost) {
        this.shadowHost.style.display = 'block';
      }
      this._isVisible = true;

      // Set push content mode with minimized width first
      if (isPushMode) {
        this.setPushContentMode(true, 56, true);
      }

      // Render the content
      this.render();

      // If it was not minimized before, schedule the expansion after a short delay
      if (!wasMinimized) {
        setTimeout(() => {
          // If push mode is enabled, update it with the full width
          if (isPushMode) {
            this.setPushContentMode(true, sidebarWidth, false);
          }
          // Force a re-render to reflect the expanded state
          this.render();
          logMessage('[SidebarManager] Sidebar expanded after initial collapsed state');
        }, 100);
      }

      logMessage(
        `[SidebarManager] Sidebar initialized with preferences: minimized=${wasMinimized}, pushMode=${isPushMode}`,
      );
    } catch (error) {
      logMessage(
        `[SidebarManager] Error loading preferences: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.show();
    }
  }

  /**
   * Refresh the sidebar content
   */
  public refreshContent(): void {
    // Re-render the sidebar with the latest content
    this.render();
  }

  /**
   * Destroy the sidebar manager
   * Override the parent destroy method to also remove the window reference
   */
  public destroy(): void {
    // Remove the window reference
    if (window.activeSidebarManager === this) {
      window.activeSidebarManager = undefined;
    }

    // Call the parent destroy method
    super.destroy();
  }
}
