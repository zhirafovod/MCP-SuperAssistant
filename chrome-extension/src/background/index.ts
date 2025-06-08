import 'webextension-polyfill';
import { exampleThemeStorage } from '@extension/storage';
import {
  runWithSSE,
  isMcpServerConnected,
  forceReconnectToMcpServer,
  checkMcpServerConnection,
} from '../mcpclient/officialmcpclient';
import { mcpInterface } from '../mcpclient/mcpinterfaceToContentScript';
import { sendAnalyticsEvent, trackError } from '../../utils/analytics';

// Default MCP server URL
const DEFAULT_MCP_SERVER_URL = 'http://localhost:3006/sse';
const API_SERVER_BASE = 'http://localhost:3000';

// Define server connection state
let isConnecting = false;
let connectionAttemptCount = 0;
const MAX_CONNECTION_ATTEMPTS = 3;

/**
 * Enhanced error categorization for better tool vs connection error distinction
 */
function categorizeToolError(error: Error): { isConnectionError: boolean; isToolError: boolean; category: string } {
  const errorMessage = error.message.toLowerCase();

  // Tool-specific errors that definitely don't indicate connection issues
  const toolErrorPatterns = [
    /tool .* not found/i,
    /tool not found/i,
    /method not found/i,
    /invalid arguments/i,
    /invalid parameters/i,
    /mcp error -32602/i, // Invalid params
    /mcp error -32601/i, // Method not found
    /mcp error -32600/i, // Invalid request
    /tool '[^']+' is not available/i,
    /tool '[^']+' not found on server/i,
  ];

  // Connection-related errors that indicate server is unavailable
  const connectionErrorPatterns = [
    /connection refused/i,
    /econnrefused/i,
    /timeout/i,
    /etimedout/i,
    /enotfound/i,
    /network error/i,
    /server unavailable/i,
    /could not connect/i,
    /connection failed/i,
    /transport error/i,
    /fetch failed/i,
  ];

  // Check tool errors first (highest priority)
  if (toolErrorPatterns.some(pattern => pattern.test(errorMessage))) {
    return { isConnectionError: false, isToolError: true, category: 'tool_error' };
  }

  // Check connection errors
  if (connectionErrorPatterns.some(pattern => pattern.test(errorMessage))) {
    return { isConnectionError: true, isToolError: false, category: 'connection_error' };
  }

  // Default to tool error for ambiguous cases to prevent unnecessary disconnections
  return { isConnectionError: false, isToolError: true, category: 'unknown_tool_error' };
}

let apiEventSource: EventSource | null = null;

async function handleChatCompletionRequest(id: string, messages: any[]): Promise<void> {
  const tabs = await chrome.tabs.query({
    url: ['*://*.chatgpt.com/*', '*://*.chat.openai.com/*', '*://*.grok.com/*'],
  });
  if (!tabs.length || tabs[0].id === undefined) {
    console.warn('No supported chat tab available for request');
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(tabs[0].id, {
      command: 'chatCompletionRequest',
      id,
      messages,
    });
    if (response && response.success) {
      await fetch(`${API_SERVER_BASE}/v1/response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, content: response.content }),
      });
    }
  } catch (err) {
    console.error('Error handling chat completion request', err);
  }
}

function connectApiServer(): void {
  if (apiEventSource) {
    apiEventSource.close();
  }
  apiEventSource = new EventSource(`${API_SERVER_BASE}/sse`);
  apiEventSource.onmessage = event => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'CHAT_COMPLETION_REQUEST') {
        handleChatCompletionRequest(data.id, data.messages);
      }
    } catch (e) {
      console.error('Failed to parse SSE message', e);
    }
  };
  apiEventSource.onerror = () => {
    console.error('API server SSE connection lost, retrying...');
    apiEventSource?.close();
    setTimeout(connectApiServer, 5000);
  };
}

/**
 * Initialize the extension
 * This function is called once when the extension starts
 */
async function initializeExtension() {
  sendAnalyticsEvent('extension_loaded', {});
  console.log('Extension initializing...');

  // Initialize theme
  try {
    const theme = await exampleThemeStorage.get();
    console.log('Theme initialized:', theme);
  } catch (error) {
    console.warn('Error initializing theme, continuing with defaults:', error);
  }

  // Wait for the MCP interface to load its server URL from storage
  await mcpInterface.waitForInitialization();

  // Get the loaded server URL from the interface
  const serverUrl = mcpInterface.getServerUrl();
  console.log('MCP Interface initialized with server URL:', serverUrl);

  // Set initial connection status
  mcpInterface.updateConnectionStatus(false);

  console.log('Extension initialized successfully');

  connectApiServer();

  // After initialization is complete, try connecting to the server asynchronously
  setTimeout(() => {
    tryConnectToServer(serverUrl).catch(() => {
      // Silently ignore errors - we've already logged them
      // and the extension should continue running
    });
  }, 1000);
}

/**
 * Try to connect to the MCP server with retry logic
 * This function is separated from extension initialization to prevent blocking
 */
async function tryConnectToServer(uri: string): Promise<void> {
  if (isConnecting) {
    console.log('Connection attempt already in progress, skipping');
    return;
  }

  isConnecting = true;
  connectionAttemptCount++;

  console.log(
    `Attempting to connect to MCP server (attempt ${connectionAttemptCount}/${MAX_CONNECTION_ATTEMPTS}): ${uri}`,
  );

  try {
    await runWithSSE(uri);

    console.log('MCP client connected successfully');
    mcpInterface.updateConnectionStatus(true);
    connectionAttemptCount = 0; // Reset counter on success
  } catch (error: any) {
    const errorCategory = categorizeToolError(error instanceof Error ? error : new Error(String(error)));

    console.warn(`MCP server connection failed (${errorCategory.category}): ${error.message || String(error)}`);
    console.log('Extension will continue to function with limited capabilities');

    // Only update connection status for actual connection errors
    if (errorCategory.isConnectionError) {
      mcpInterface.updateConnectionStatus(false);
    } else {
      console.log('Error categorized as tool-related, not updating connection status');
    }

    // Schedule another attempt if we haven't reached the limit
    if (connectionAttemptCount < MAX_CONNECTION_ATTEMPTS) {
      const delayMs = Math.min(5000 * connectionAttemptCount, 15000); // Exponential backoff with cap
      console.log(`Scheduling next connection attempt in ${delayMs / 1000} seconds...`);

      setTimeout(() => {
        isConnecting = false; // Reset connecting flag
        tryConnectToServer(uri).catch(() => {}); // Try again
      }, delayMs);
    } else {
      console.log('Maximum connection attempts reached. Will try again during periodic check.');
      isConnecting = false;
    }
  } finally {
    if (connectionAttemptCount >= MAX_CONNECTION_ATTEMPTS) {
      isConnecting = false;
    }
  }
}

// Set up a periodic connection check
const PERIODIC_CHECK_INTERVAL = 60000; // 1 minute
setInterval(async () => {
  if (isConnecting) {
    return; // Skip if already connecting
  }

  // Check current connection status
  const isConnected = await checkMcpServerConnection();
  mcpInterface.updateConnectionStatus(isConnected);

  // If not connected and we're not in the middle of connecting, try to connect
  if (!isConnected && !isConnecting) {
    connectionAttemptCount = 0; // Reset counter for periodic checks
    console.log('Periodic check: MCP server not connected, attempting to connect');
    const serverUrl = mcpInterface.getServerUrl();
    tryConnectToServer(serverUrl).catch(() => {});
  }
}, PERIODIC_CHECK_INTERVAL);

// Log active connections periodically
setInterval(() => {
  const connectionCount = mcpInterface.getConnectionCount();
  if (connectionCount > 0) {
    console.log(`Active MCP content script connections: ${connectionCount}`);
  }
}, 60000);

// --- Error Handling ---
// Listen for unhandled errors in the service worker
// Note: This may not catch all async errors perfectly depending on how they propagate
self.addEventListener('unhandledrejection', event => {
  console.error('Unhandled rejection in service worker:', event.reason);
  if (event.reason instanceof Error) {
    trackError(event.reason, 'background_unhandled_rejection');
  } else {
    // Handle non-Error rejections if necessary
    sendAnalyticsEvent('extension_error', {
      error_message: `Unhandled rejection: ${JSON.stringify(event.reason)}`,
      error_context: 'background_unhandled_rejection_non_error',
    });
  }
});

self.addEventListener('error', event => {
  console.error('Uncaught error in service worker:', event.error);
  if (event.error instanceof Error) {
    trackError(event.error, 'background_uncaught_error');
  } else {
    sendAnalyticsEvent('extension_error', {
      error_message: `Uncaught error: ${event.message}`,
      error_context: 'background_uncaught_error_non_error',
    });
  }
});

// --- Lifecycle Events ---

chrome.runtime.onInstalled.addListener(details => {
  console.log('Extension installed or updated:', details.reason);
  sendAnalyticsEvent('extension_installed', { reason: details.reason });

  // Perform initial setup on first install
  if (details.reason === 'install') {
    // You might want to set default settings here
    console.log('Performing first-time installation setup.');
    // Example: Set default server URL if not already set (although initializeServerUrl handles this)
  } else if (details.reason === 'update') {
    console.log(`Extension updated from ${details.previousVersion}`);
    // Handle updates if needed
  }

  // Re-initialize after install/update (optional, depending on setup)
  // initializeExtension().catch(err => console.error("Error re-initializing after install:", err));
});

chrome.runtime.onStartup.addListener(() => {
  console.log('Browser startup detected.');
  sendAnalyticsEvent('browser_startup', {});
  // Re-check connection on startup
  initializeExtension().catch(err => console.error('Error initializing on startup:', err));
});

// Start extension initialization
initializeExtension()
  .then(() => {
    console.log('Extension startup complete');
  })
  .catch(error => {
    console.error('Error during extension initialization:', error);
    console.log('Extension will continue running with limited functionality');
  });

console.log('Background script loaded');
console.log("Edit 'chrome-extension/src/background/index.ts' and save to reload.");

// --- Message Handling ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.debug('[Background] Received message:', message);
  if (message.command === 'trackAnalyticsEvent') {
    if (message.eventName && message.eventParams) {
      sendAnalyticsEvent(message.eventName, message.eventParams)
        .then(() => {
          sendResponse({ success: true });
        })
        .catch(error => {
          console.error('[Background] Error tracking analytics event from message:', error);
          sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
        });
      return true; // Indicates asynchronous response
    } else {
      console.warn('[Background] Invalid trackAnalyticsEvent message received:', message);
      sendResponse({ success: false, error: 'Invalid eventName or eventParams' });
    }
  }
  // Keep this return false if no other async handlers are present or if this is the only handler
  // If other handlers might respond asynchronously, you might need to return true based on conditions.
  // For this specific handler, returning true within the `if` block is correct.
  // However, if no message command matches, we should let the channel close.
  return false; // Default: No async response unless handled above
});
