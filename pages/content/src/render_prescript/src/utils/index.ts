// Re-export all utility functions
export * from './dom';
export * from './performance';
export * from './themeDetector';

// Add a global utility for theme control that can be accessed from the console
if (typeof window !== 'undefined') {
  (window as any).themeControl = {
    forceLight: () => {
      const { forceThemeMode, clearCachedTheme } = require('./themeDetector');
      forceThemeMode('light');
      console.debug('Forced light theme. Refresh the page to see changes.');
    },
    forceDark: () => {
      const { forceThemeMode, clearCachedTheme } = require('./themeDetector');
      forceThemeMode('dark');
      console.debug('Forced dark theme. Refresh the page to see changes.');
    },
    useSystem: () => {
      const { forceThemeMode, clearCachedTheme } = require('./themeDetector');
      forceThemeMode('system');
      console.debug('Using system theme preference. Refresh the page to see changes.');
    },
    reset: () => {
      const { clearCachedTheme } = require('./themeDetector');
      clearCachedTheme();
      console.debug('Theme detection reset. Refresh the page to see changes.');
    },
    detect: () => {
      const { detectHostTheme, isDarkTheme } = require('./themeDetector');
      const theme = detectHostTheme();
      const isDark = isDarkTheme();
      console.debug(`Detected theme: ${theme}`);
      console.debug(`Using ${isDark ? 'dark' : 'light'} theme`);
      return { theme, isDark };
    },
  };

  console.debug('[Theme Detector] Global theme control available via window.themeControl');
}
