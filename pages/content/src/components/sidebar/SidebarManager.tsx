import type React from 'react';
import type { SiteType } from './base/BaseSidebarManager';
import { BaseSidebarManager } from './base/BaseSidebarManager';
import { logMessage } from '@src/utils/helpers';
import Sidebar from './Sidebar';
import { getSidebarPreferences, type SidebarPreferences } from '@src/utils/storage';

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
  private initialPreferences: SidebarPreferences | null = null;
  private isRendering: boolean = false; // CRITICAL FIX: Prevent multiple concurrent renders
  private lastRenderTime: number = 0; // CRITICAL FIX: Throttle renders

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
   * Override show method to ensure preferences are loaded before rendering
   */
  public async show(): Promise<void> {
    // CRITICAL FIX: Always load preferences before showing sidebar
    if (!this.initialPreferences) {
      logMessage('[SidebarManager] Loading preferences before show()');
      try {
        this.initialPreferences = await getSidebarPreferences();
        logMessage(`[SidebarManager] Loaded preferences for show(): ${JSON.stringify(this.initialPreferences)}`);

        // Set the data-initial-minimized attribute based on loaded preferences
        await this.initialize(); // Ensure initialized
        if (this.shadowHost) {
          const wasMinimized = this.initialPreferences?.isMinimized ?? false;
          this.shadowHost.setAttribute('data-initial-minimized', wasMinimized ? 'true' : 'false');
          logMessage(`[SidebarManager] Set data-initial-minimized to '${wasMinimized ? 'true' : 'false'}'`);
        }
      } catch (error) {
        logMessage(
          `[SidebarManager] Error loading preferences in show(): ${error instanceof Error ? error.message : String(error)}`,
        );
        // Continue with null preferences and let Sidebar component handle it
      }
    }

    // Now call the parent show method which will render with proper preferences
    return super.show();
  }

  /**
   * Create sidebar content
   */
  protected createSidebarContent(): React.ReactNode {
    // CRITICAL FIX: Ensure preferences are always loaded before rendering
    // If initialPreferences is null, it means render() was called before showWithToolOutputs()
    // In this case, we should load preferences synchronously or provide safe defaults
    if (!this.initialPreferences) {
      logMessage('[SidebarManager] WARNING: createSidebarContent called without initialPreferences loaded');
      // For safety, we'll pass null and let Sidebar component handle the fallback
      // The Sidebar component will load preferences asynchronously if needed
    }

    return <Sidebar initialPreferences={this.initialPreferences} />;
  }

  /**
   * Show the sidebar with tool outputs - Load preferences first to prevent flash
   */
  public showWithToolOutputs(): void {
    // Add delay to ensure host website has fully loaded and won't interfere
    logMessage('[SidebarManager] Scheduling sidebar initialization with 500ms delay');

    setTimeout(async () => {
      logMessage('[SidebarManager] Starting delayed sidebar initialization');

      try {
        // Load preferences BEFORE React renders anything
        logMessage('[SidebarManager] Loading preferences before render...');
        this.initialPreferences = await getSidebarPreferences();
        logMessage(`[SidebarManager] Loaded preferences: ${JSON.stringify(this.initialPreferences)}`);

        // Initialize with collapsed state to restore preferences including push mode
        await this.initializeCollapsedState();
        logMessage('[SidebarManager] Sidebar shown successfully with preferences restored');
      } catch (error) {
        logMessage(
          `[SidebarManager] Error during initialization: ${error instanceof Error ? error.message : String(error)}`,
        );
        // OPTIMIZATION: Fallback to basic show method but avoid double render
        try {
          // Initialize without rendering first, then render once
          await this.initialize();
          if (this.shadowHost) {
            this.shadowHost.style.display = 'block';
            this.shadowHost.style.opacity = '1';
            this.shadowHost.classList.add('initialized');
            this._isVisible = true;

            // Single render call
            this.render();
            logMessage('[SidebarManager] Fallback initialization with single render completed');
          }
        } catch (showError) {
          logMessage(
            `[SidebarManager] Even fallback initialization failed: ${showError instanceof Error ? showError.message : String(showError)}`,
          );
        }
      }
    }, 500);

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

    // Initialize the sidebar DOM without rendering React yet
    await this.initialize();

    // Use already-loaded preferences or load them if not available
    try {
      if (!this.initialPreferences) {
        logMessage('[SidebarManager] initialPreferences is null, fetching in initializeCollapsedState');
        try {
            this.initialPreferences = await getSidebarPreferences();
        } catch (e) {
            logMessage(`[SidebarManager] Error fetching preferences in initializeCollapsedState: ${e instanceof Error ? e.message : String(e)}. Using defaults.`);
            // Explicitly set to null so the next block assigns defaults
            this.initialPreferences = null;
        }
      }

      // If still null (either initialPreferences was null and fetch failed, or it was explicitly set to null after fetch error), assign defaults.
      if (!this.initialPreferences) {
          logMessage('[SidebarManager] Preferences still null after fetch attempt or error, using defaults for initialization.');
          this.initialPreferences = {
              isMinimized: false,
              isPushMode: false,
              sidebarWidth: 320, // Default width
              autoSubmit: false,
              theme: 'system', // Default theme
              customInstructions: '', // Added missing field
              customInstructionsEnabled: false, // Added missing field
          };
      }
      // Now, this.initialPreferences is guaranteed to be non-null.
      const preferences = this.initialPreferences;

      const wasMinimized = preferences.isMinimized ?? false;
      const isPushMode = preferences.isPushMode ?? false;
      const sidebarWidth = preferences.sidebarWidth || 320;

      logMessage(
        `[SidebarManager] Using preferences for initialization: minimized=${wasMinimized}, pushMode=${isPushMode}, width=${sidebarWidth}`,
      );

      // CRITICAL: Set ALL attributes and styles BEFORE making sidebar visible and rendering React
      if (this.shadowHost) {
        // Set initial state attributes FIRST - this is what React will read
        if (wasMinimized) {
          this.shadowHost.setAttribute('data-initial-minimized', 'true');
          // Force immediate width for minimized state
          this.shadowHost.style.width = '56px';
        } else {
          // Ensure the attribute is explicitly set to false for expanded state
          this.shadowHost.setAttribute('data-initial-minimized', 'false');
        }

        // Make sidebar visible
        this.shadowHost.style.display = 'block';
        this.shadowHost.style.opacity = '1';
        this.shadowHost.classList.add('initialized');
      }
      this._isVisible = true;

      // Set push content mode with appropriate width immediately
      if (isPushMode) {
        const initialWidth = wasMinimized ? 56 : sidebarWidth;
        this.setPushContentMode(true, initialWidth, wasMinimized);

        // Verify push mode was applied correctly and retry if needed
        this.verifyAndRetryPushMode(initialWidth, wasMinimized);
      }

      // CRITICAL: Only render React ONCE with all setup complete
      // Force a small delay to ensure all DOM attributes are fully applied and readable
      setTimeout(() => {
        logMessage('[SidebarManager] Rendering React component with all initial state ready');
        this.render();

        // Mark as fully initialized
        logMessage(`[SidebarManager] Sidebar fully initialized: minimized=${wasMinimized}, pushMode=${isPushMode}`);
      }, 20); // Slightly longer delay to ensure DOM is fully ready
    } catch (error) {
      logMessage(
        `[SidebarManager] Error loading preferences: ${error instanceof Error ? error.message : String(error)}`,
      );
      // OPTIMIZATION: Fallback with proper attribute setting to prevent re-renders
      try {
        // CRITICAL FIX: Load preferences or use defaults even in fallback scenario
        if (!this.initialPreferences) {
          logMessage('[SidebarManager] Loading preferences for fallback initialization or using defaults.');
          try {
            this.initialPreferences = await getSidebarPreferences();
          } catch (e) {
            logMessage(`[SidebarManager] Error fetching preferences in fallback: ${e instanceof Error ? e.message : String(e)}. Using defaults.`);
            this.initialPreferences = null; // Ensure it's null before assigning defaults if fetch fails
          }

          if (!this.initialPreferences) {
            logMessage('[SidebarManager] Preferences still null in fallback after fetch attempt, using defaults.');
            this.initialPreferences = {
                isMinimized: false,
                isPushMode: false,
                sidebarWidth: 320,
                autoSubmit: false,
                theme: 'system',
                customInstructions: '', // Added missing field
                customInstructionsEnabled: false, // Added missing field
            };
          }
        }
        // Now, this.initialPreferences is guaranteed to be non-null for the fallback.
        const fallbackPreferences = this.initialPreferences;

        // Initialize without rendering first, then render once with proper attributes
        await this.initialize();
        if (this.shadowHost) {
          // CRITICAL: Set the data-initial-minimized attribute based on loaded preferences
          const wasMinimized = fallbackPreferences.isMinimized ?? false;
          this.shadowHost.setAttribute('data-initial-minimized', wasMinimized ? 'true' : 'false');

          // Set initial width based on minimized state
          if (wasMinimized) {
            this.shadowHost.style.width = '56px';
          }

          this.shadowHost.style.display = 'block';
          this.shadowHost.style.opacity = '1';
          this.shadowHost.classList.add('initialized');
          this._isVisible = true;

          // Single render call with preferences now available
          this.render();
          logMessage('[SidebarManager] Fallback initialization with single render completed');
        }
      } catch (showError) {
        logMessage(
          `[SidebarManager] Even fallback initialization failed: ${showError instanceof Error ? showError.message : String(showError)}`,
        );
      }
    }
  }

  /**
   * Verify that push mode has been applied correctly and retry if needed
   * @param width The expected sidebar width
   * @param isCollapsed Whether the sidebar should be in collapsed state
   */
  private verifyAndRetryPushMode(width: number, isCollapsed: boolean): void {
    // Check if push mode styles are actually applied
    const hasClass = document.documentElement.classList.contains('push-mode-enabled');
    const hasMargin = document.documentElement.style.marginRight !== '';
    const hasWidth = document.documentElement.style.width !== '';

    const isPushModeApplied = hasClass && hasMargin && hasWidth;

    if (!isPushModeApplied) {
      logMessage('[SidebarManager] Push mode verification failed, retrying...');

      // Retry applying push mode after a short delay
      setTimeout(() => {
        this.setPushContentMode(true, width, isCollapsed);

        // Verify again after retry
        setTimeout(() => {
          const retryHasClass = document.documentElement.classList.contains('push-mode-enabled');
          const retryHasMargin = document.documentElement.style.marginRight !== '';
          const retryHasWidth = document.documentElement.style.width !== '';

          if (retryHasClass && retryHasMargin && retryHasWidth) {
            logMessage('[SidebarManager] Push mode successfully applied after retry');
          } else {
            logMessage('[SidebarManager] Push mode still failed after retry - website may be interfering');
          }
        }, 50);
      }, 50);
    } else {
      logMessage('[SidebarManager] Push mode verification successful');
    }
  }

  /**
   * Refresh the sidebar content
   * OPTIMIZATION: Instead of re-rendering the entire React tree, use React's
   * built-in state management and data flow to update content
   */
  public refreshContent(): void {
    logMessage('[SidebarManager] Content refresh requested - relying on React state updates instead of full re-render');

    // REMOVED: Direct render() call that destroys and recreates the entire component tree
    // this.render();

    // The sidebar content will automatically update through:
    // 1. Background communication hooks that manage state
    // 2. Component re-renders triggered by state changes
    // 3. useEffect hooks that respond to data changes

    // If a full re-render is absolutely necessary (rare), it should be done
    // through specific state updates in the React component, not here

    // Optional: Trigger a custom event that components can listen to
    if (this.shadowHost) {
      const refreshEvent = new CustomEvent('mcpSidebarRefresh', {
        detail: { timestamp: Date.now() },
      });
      this.shadowHost.dispatchEvent(refreshEvent);
    }
  }

  /**
   * Override render method to prevent multiple concurrent renders
   */
  protected render(): void {
    const now = Date.now();

    // CRITICAL FIX: Prevent multiple renders in quick succession
    if (this.isRendering) {
      logMessage('[SidebarManager] BLOCKED: Render already in progress, skipping duplicate render');
      return;
    }

    // CRITICAL FIX: Throttle renders to at most once every 100ms
    if (now - this.lastRenderTime < 100) {
      logMessage('[SidebarManager] BLOCKED: Render throttled, too soon since last render');
      return;
    }

    this.isRendering = true;
    this.lastRenderTime = now;

    try {
      logMessage('[SidebarManager] Starting protected render');
      super.render();
      logMessage('[SidebarManager] Protected render completed successfully');
    } catch (error) {
      logMessage(
        `[SidebarManager] Error in protected render: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      // Allow future renders after a brief delay
      setTimeout(() => {
        this.isRendering = false;
      }, 50);
    }
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
