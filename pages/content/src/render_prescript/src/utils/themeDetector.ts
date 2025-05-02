/**
 * Utility functions for detecting the host website's theme
 */

import { CONFIG } from '../core/config';
import { renderedFunctionBlocks } from '../renderer/functionBlock';

/**
 * Theme detection result
 */
export type ThemeMode = 'light' | 'dark' | 'system';

// Store the detected theme to avoid recalculating
let cachedTheme: ThemeMode | null = null;

// Store the current theme state for comparison
let currentThemeState = {
  bodyClasses: '',
  htmlClasses: '',
  bodyDataTheme: '',
  htmlDataTheme: '',
  bodyBgColor: '',
  isDark: false,
};

// Callback registry for theme change listeners
type ThemeChangeCallback = (isDark: boolean) => void;
const themeChangeListeners: ThemeChangeCallback[] = [];

// Theme observer instance
let themeObserver: MutationObserver | null = null;

// Theme change detection delay (to avoid excessive updates)
const THEME_CHANGE_DELAY = 100; // ms

/**
 * Logs theme detection information if debug is enabled
 * @param message The message to log
 * @param data Optional data to include in the log
 */
function logThemeDetection(message: string, data?: any): void {
  if (CONFIG.debug) {
    console.debug(`[ThemeDetector] ${message}`, data || '');
  }
}

/**
 * Detects the theme of the host website
 * @returns The detected theme mode ('light', 'dark', or 'system')
 */
export function detectHostTheme(): ThemeMode {
  // Return cached theme if available
  if (cachedTheme) {
    logThemeDetection(`Using cached theme: ${cachedTheme}`);
    return cachedTheme;
  }

  // If host theme detection is disabled, use system preference
  if (!CONFIG.useHostTheme) {
    logThemeDetection('Host theme detection disabled, using system preference');
    cachedTheme = 'system';
    return cachedTheme;
  }

  try {
    // Common selectors and attributes used for theme detection
    const bodyEl = document.body;
    const htmlEl = document.documentElement;

    if (!bodyEl || !htmlEl) {
      logThemeDetection('DOM not fully loaded, using system preference');
      return 'system';
    }

    // Check for common theme indicators in class names
    const bodyClasses = bodyEl.className.toLowerCase() || '';
    const htmlClasses = htmlEl.className.toLowerCase() || '';
    const allClasses = bodyClasses + ' ' + htmlClasses;

    logThemeDetection('Checking classes for theme indicators', { bodyClasses, htmlClasses });

    // Check for data attributes that might indicate theme
    const bodyDataTheme = bodyEl.getAttribute('data-theme');
    const htmlDataTheme = htmlEl.getAttribute('data-theme');

    logThemeDetection('Checking data attributes for theme', { bodyDataTheme, htmlDataTheme });

    // Check for common theme class patterns
    const darkClassPatterns = ['dark-theme', 'theme-dark', 'dark-mode', 'dark', 'night-mode', 'nightmode'];
    const lightClassPatterns = ['light-theme', 'theme-light', 'light-mode', 'light', 'day-mode', 'daymode'];

    // Check if any dark pattern is found in classes
    const hasDarkClass = darkClassPatterns.some(pattern => allClasses.includes(pattern));
    // Check if any light pattern is found in classes
    const hasLightClass = lightClassPatterns.some(pattern => allClasses.includes(pattern));

    // Check data attributes
    const hasDarkDataAttr = bodyDataTheme === 'dark' || htmlDataTheme === 'dark';
    const hasLightDataAttr = bodyDataTheme === 'light' || htmlDataTheme === 'light';

    if (hasDarkClass || hasDarkDataAttr) {
      logThemeDetection('Dark theme detected from classes or data attributes');
      cachedTheme = 'dark';
      return cachedTheme;
    }

    if (hasLightClass || hasLightDataAttr) {
      logThemeDetection('Light theme detected from classes or data attributes');
      cachedTheme = 'light';
      return cachedTheme;
    }

    // Check for color scheme meta tag
    const metaColorScheme = document.querySelector('meta[name="color-scheme"]');
    if (metaColorScheme) {
      const content = metaColorScheme.getAttribute('content');
      logThemeDetection('Found color-scheme meta tag', { content });

      if (content?.includes('dark')) {
        cachedTheme = 'dark';
        return cachedTheme;
      } else if (content?.includes('light')) {
        cachedTheme = 'light';
        return cachedTheme;
      }
    }

    // Check for dark background color as a fallback
    try {
      const bodyBgColor = window.getComputedStyle(bodyEl).backgroundColor;
      logThemeDetection('Checking background color', { bodyBgColor });

      if (bodyBgColor) {
        // Extract RGB values
        const rgbMatch = bodyBgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        if (rgbMatch) {
          const [_, r, g, b] = rgbMatch.map(Number);
          // Calculate brightness using a common formula
          const brightness = (r * 299 + g * 587 + b * 114) / 1000;
          logThemeDetection('Calculated brightness', { brightness, threshold: 128 });

          // If brightness is low, it's likely a dark theme
          if (brightness < 128) {
            logThemeDetection('Dark theme detected from background color');
            cachedTheme = 'dark';
            return cachedTheme;
          }
          logThemeDetection('Light theme detected from background color');
          cachedTheme = 'light';
          return cachedTheme;
        }
      }
    } catch (error) {
      logThemeDetection('Error analyzing background color', error);
    }

    // Additional check for dark mode using CSS variables
    try {
      const cssVars = [
        getComputedStyle(document.documentElement).getPropertyValue('--background-color'),
        getComputedStyle(document.documentElement).getPropertyValue('--bg-color'),
        getComputedStyle(document.documentElement).getPropertyValue('--background'),
        getComputedStyle(document.documentElement).getPropertyValue('--bg'),
      ];

      logThemeDetection('Checking CSS variables', cssVars);

      // Check if any CSS variable contains a dark color
      for (const cssVar of cssVars) {
        if (cssVar && cssVar.match(/#([0-9a-f]{3}){1,2}/i)) {
          const hex = cssVar.trim().replace('#', '');
          const r = parseInt(hex.length === 3 ? hex[0] + hex[0] : hex.substring(0, 2), 16);
          const g = parseInt(hex.length === 3 ? hex[1] + hex[1] : hex.substring(2, 4), 16);
          const b = parseInt(hex.length === 3 ? hex[2] + hex[2] : hex.substring(4, 6), 16);

          if (r !== undefined && g !== undefined && b !== undefined) {
            const brightness = (r * 299 + g * 587 + b * 114) / 1000;
            logThemeDetection('CSS variable brightness', { cssVar, brightness });

            if (brightness < 128) {
              logThemeDetection('Dark theme detected from CSS variables');
              cachedTheme = 'dark';
              return cachedTheme;
            }
          }
        }
      }
    } catch (error) {
      logThemeDetection('Error analyzing CSS variables', error);
    }

    // Check if the website URL matches known dark-themed sites
    const currentUrl = window.location.href.toLowerCase();
    const knownDarkSites = ['github.com/dark', 'twitter.com/dark', 'discord.com'];
    const knownLightSites = ['google.com', 'bing.com', 'yahoo.com'];

    logThemeDetection('Checking URL against known themed sites', { currentUrl });

    if (knownDarkSites.some(site => currentUrl.includes(site))) {
      logThemeDetection('Dark theme detected from known site list');
      cachedTheme = 'dark';
      return cachedTheme;
    }

    if (knownLightSites.some(site => currentUrl.includes(site))) {
      logThemeDetection('Light theme detected from known site list');
      cachedTheme = 'light';
      return cachedTheme;
    }

    // Default to system preference if we can't determine
    logThemeDetection('Could not determine theme, using system preference');
    cachedTheme = 'system';
    return cachedTheme;
  } catch (error) {
    console.error('Error detecting host theme:', error);
    logThemeDetection('Error in theme detection, using system preference', error);
    cachedTheme = 'system';
    return cachedTheme;
  }
}

/**
 * Determines if the current theme is dark
 * @returns true if the theme is dark, false otherwise
 */
export function isDarkTheme(): boolean {
  const hostTheme = detectHostTheme();

  if (hostTheme === 'dark') {
    logThemeDetection('Using dark theme based on host detection');
    return true;
  }

  if (hostTheme === 'light') {
    logThemeDetection('Using light theme based on host detection');
    return false;
  }

  // Fall back to system preference if theme is 'system'
  const systemPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  logThemeDetection(`Using ${systemPrefersDark ? 'dark' : 'light'} theme based on system preference`);
  return systemPrefersDark;
}

/**
 * Forces a specific theme mode (useful for testing or user preferences)
 * @param mode The theme mode to force
 */
export function forceThemeMode(mode: ThemeMode): void {
  cachedTheme = mode;
  logThemeDetection(`Theme mode forced to: ${mode}`);

  // Update all function blocks with the new theme
  updateAllFunctionBlocks();
}

/**
 * Clears the cached theme, forcing a re-detection on next call
 */
export function clearCachedTheme(): void {
  cachedTheme = null;
  logThemeDetection('Cached theme cleared');

  // Update all function blocks with the new theme
  updateAllFunctionBlocks();
}

/**
 * Updates the theme for all rendered function blocks
 */
export function updateAllFunctionBlocks(): void {
  // Force theme re-detection
  const isDark = isDarkTheme();
  const themeClass = isDark ? 'theme-dark' : 'theme-light';

  logThemeDetection(`Updating all function blocks to theme: ${themeClass}`);

  // Update all rendered function blocks
  renderedFunctionBlocks.forEach((blockDiv, blockId) => {
    applyThemeClass(blockDiv);
  });

  // Notify all theme change listeners
  notifyThemeChangeListeners(isDark);

  // Initialize the theme observer if it hasn't been already
  initThemeObserver();
}

/**
 * Adds a theme class to the function block container
 * @param element The element to add the theme class to
 */
export function applyThemeClass(element: HTMLElement): void {
  if (!element) return;

  const isDark = isDarkTheme();

  // Remove any existing theme classes
  element.classList.remove('theme-dark', 'theme-light');

  // Add the appropriate theme class
  const themeClass = isDark ? 'theme-dark' : 'theme-light';
  element.classList.add(themeClass);

  logThemeDetection(`Applied theme class '${themeClass}' to element`, {
    elementId: element.id,
    elementClass: element.className,
  });

  // Initialize the theme observer if it hasn't been already
  initThemeObserver();
}

/**
 * Register a callback to be notified when the theme changes
 * @param callback Function to call when theme changes
 */
export function onThemeChange(callback: ThemeChangeCallback): void {
  themeChangeListeners.push(callback);
}

/**
 * Notify all registered theme change listeners
 * @param isDark Whether the new theme is dark
 */
function notifyThemeChangeListeners(isDark: boolean): void {
  themeChangeListeners.forEach(callback => {
    try {
      callback(isDark);
    } catch (error) {
      console.error('Error in theme change listener:', error);
    }
  });
}

/**
 * Initialize the theme observer to watch for theme changes
 */
function initThemeObserver(): void {
  // Only initialize once
  if (themeObserver) return;

  // Capture initial state
  currentThemeState = captureThemeState();
  logThemeDetection('Initial theme state captured', currentThemeState);

  // Create debounced theme check function
  let themeChangeTimeout: number | null = null;
  const debouncedThemeCheck = () => {
    // Clear any existing timeout
    if (themeChangeTimeout !== null) {
      window.clearTimeout(themeChangeTimeout);
    }

    // Set new timeout
    themeChangeTimeout = window.setTimeout(() => {
      if (hasThemeStateChanged()) {
        // Theme has changed, update all function blocks
        updateAllFunctionBlocks();
      }
      themeChangeTimeout = null;
    }, THEME_CHANGE_DELAY);
  };

  // Create mutation observer to watch for theme changes
  themeObserver = new MutationObserver(mutations => {
    // Check if any mutations might indicate a theme change
    const potentialThemeChange = mutations.some(mutation => {
      // Class changes on body or html
      if (
        mutation.type === 'attributes' &&
        (mutation.target === document.body || mutation.target === document.documentElement) &&
        (mutation.attributeName === 'class' ||
          mutation.attributeName === 'data-theme' ||
          mutation.attributeName === 'style')
      ) {
        return true;
      }
      // Also check for changes to <meta name="theme-color"> or <meta name="color-scheme">
      if (
        mutation.type === 'attributes' &&
        mutation.target instanceof HTMLMetaElement &&
        (mutation.target.name === 'theme-color' || mutation.target.name === 'color-scheme')
      ) {
        return true;
      }
      // Check for changes to CSS variables that might affect theme
      if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
        return true;
      }
      return false;
    });

    if (potentialThemeChange) {
      logThemeDetection('Potential theme change detected from mutations');
      debouncedThemeCheck();
    }
  });

  // Start observing body and html for class and attribute changes
  if (themeObserver !== null && document.body) {
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    });
  }

  if (themeObserver !== null && document.documentElement) {
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    });
  }

  // Also observe <head> for changes to meta tags related to theme
  const headElement = document.head;
  if (headElement && themeObserver !== null) {
    themeObserver.observe(headElement, {
      childList: true, // Watch for added/removed meta tags
      subtree: true, // Watch all descendants
      attributes: true, // Watch for attribute changes
      attributeFilter: ['content'], // Only care about content changes
    });

    // Find and observe specific meta tags that might indicate theme
    const themeMetas = headElement.querySelectorAll('meta[name="theme-color"], meta[name="color-scheme"]');
    themeMetas.forEach(meta => {
      if (themeObserver !== null) {
        themeObserver.observe(meta, {
          attributes: true,
          attributeFilter: ['content'],
        });
      }
    });
  }

  // Also watch for color scheme changes in media query
  try {
    const colorSchemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
    // Use the standard event listener method with fallback for older browsers
    if (colorSchemeMedia.addEventListener) {
      colorSchemeMedia.addEventListener('change', () => {
        logThemeDetection('System color scheme preference changed');
        // Only update if we're using system preference
        if (cachedTheme === 'system' || cachedTheme === null) {
          debouncedThemeCheck();
        }
      });
    } else if (colorSchemeMedia.addListener) {
      // Fallback for Safari < 14
      colorSchemeMedia.addListener(() => {
        logThemeDetection('System color scheme preference changed (legacy event)');
        if (cachedTheme === 'system' || cachedTheme === null) {
          debouncedThemeCheck();
        }
      });
    }

    // Also listen for changes to CSS variables that might affect theme
    window.addEventListener('load', () => {
      // Some websites dynamically load theme after initial page load
      setTimeout(() => {
        // Force a one-time check after page has fully loaded
        debouncedThemeCheck();
      }, 1000);
    });
  } catch (error) {
    logThemeDetection('Error setting up media query listener', error);
  }

  // We're using fully event-based detection, so no periodic checks are needed

  // Clean up on page unload
  window.addEventListener('beforeunload', () => {
    if (themeObserver !== null) {
      themeObserver.disconnect();
      themeObserver = null;
    }
  });

  logThemeDetection('Theme observer initialized');
}

/**
 * Captures the current theme state for comparison
 */
function captureThemeState(): typeof currentThemeState {
  try {
    const bodyEl = document.body;
    const htmlEl = document.documentElement;

    if (!bodyEl || !htmlEl) {
      return currentThemeState;
    }

    return {
      bodyClasses: bodyEl.className,
      htmlClasses: htmlEl.className,
      bodyDataTheme: bodyEl.getAttribute('data-theme') || '',
      htmlDataTheme: htmlEl.getAttribute('data-theme') || '',
      bodyBgColor: window.getComputedStyle(bodyEl).backgroundColor,
      isDark: isDarkTheme(),
    };
  } catch (error) {
    logThemeDetection('Error capturing theme state', error);
    return currentThemeState;
  }
}

/**
 * Checks if the theme state has changed
 */
function hasThemeStateChanged(): boolean {
  const newState = captureThemeState();

  // Compare relevant properties
  const hasChanged =
    newState.bodyClasses !== currentThemeState.bodyClasses ||
    newState.htmlClasses !== currentThemeState.htmlClasses ||
    newState.bodyDataTheme !== currentThemeState.bodyDataTheme ||
    newState.htmlDataTheme !== currentThemeState.htmlDataTheme ||
    newState.bodyBgColor !== currentThemeState.bodyBgColor ||
    newState.isDark !== currentThemeState.isDark;

  if (hasChanged) {
    logThemeDetection('Theme state changed', {
      from: currentThemeState,
      to: newState,
    });

    // Update current state
    currentThemeState = newState;

    // Clear the theme cache to force re-detection
    cachedTheme = null;
  }

  return hasChanged;
}
