// import { logMessage } from './helpers'; // Assuming helpers exists in utils - Replaced with console.debug

// IMPORTANT: Load credentials via environment variables during build
// It's strongly recommended to load these from a secure configuration or environment variables during build,
// rather than hardcoding them directly in the source code.
// Create a .env file in the chrome-extension directory with:
// VITE_GA_MEASUREMENT_ID=G-XXXXXXXXXX
// VITE_GA_API_SECRET=YOUR_API_SECRET
// Ensure .env is in your .gitignore file!
// VITE_GA_API_SECRET=YOUR_API_SECRET
// Ensure .env is in your .gitignore file!
const MEASUREMENT_ID = import.meta.env.CEB_GA_MEASUREMENT_ID;
const API_SECRET = import.meta.env.CEB_GA_API_SECRET;

const GA_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
const GA_DEBUG_ENDPOINT = 'https://www.google-analytics.com/debug/mp/collect';

// Use debug endpoint for development
const IS_DEV_MODE = !('update_url' in chrome.runtime.getManifest());
// const API_ENDPOINT = IS_DEV_MODE ? GA_DEBUG_ENDPOINT : GA_ENDPOINT;
const API_ENDPOINT = GA_ENDPOINT;

const DEFAULT_ENGAGEMENT_TIME_IN_MSEC = 100; // Standard value for measurement protocol
const SESSION_EXPIRATION_IN_MIN = 30;

// --- Client ID Management ---
async function getOrCreateClientId(): Promise<string> {
  try {
    const result = await chrome.storage.local.get('clientId');
    let clientId = result.clientId;
    if (!clientId) {
      // Generate a unique client ID, the actual value is not relevant
      clientId = self.crypto.randomUUID();
      await chrome.storage.local.set({ clientId });
      // logMessage('[GA4] Generated new clientId:', clientId);
      console.debug('[GA4] Generated new clientId:', clientId);
    }
    return clientId;
  } catch (error) {
    console.error('[GA4] Error getting or creating clientId:', error);
    // Fallback or rethrow depending on desired robustness
    return 'error-client-id';
  }
}

// --- Session ID Management ---
async function getOrCreateSessionId(): Promise<string> {
  try {
    // Use session storage to keep session ID alive while browser is open
    let { sessionData } = await chrome.storage.session.get('sessionData');
    const currentTimeInMs = Date.now();

    if (sessionData && sessionData.timestamp) {
      const durationInMin = (currentTimeInMs - sessionData.timestamp) / 60000;
      // Check if session has expired
      if (durationInMin > SESSION_EXPIRATION_IN_MIN) {
        sessionData = null; // Expired, start a new session
        // logMessage('[GA4] Session expired, starting new one.');
        console.debug('[GA4] Session expired, starting new one.');
      } else {
        // Session valid, update timestamp
        sessionData.timestamp = currentTimeInMs;
        await chrome.storage.session.set({ sessionData });
      }
    }

    if (!sessionData) {
      // Create and store a new session
      sessionData = {
        session_id: currentTimeInMs.toString(),
        timestamp: currentTimeInMs, // Store timestamp as number
      };
      await chrome.storage.session.set({ sessionData });
      // logMessage('[GA4] Created new session:', sessionData.session_id);
      console.debug('[GA4] Created new session:', sessionData.session_id);
    }
    return sessionData.session_id;
  } catch (error) {
    console.error('[GA4] Error getting or creating session_id:', error);
    return 'error-session-id';
  }
}

// --- Event Sending ---
/**
 * Sends an event to Google Analytics using the Measurement Protocol.
 *
 * @param name The name of the event.
 * @param params Additional parameters for the event.
 */
export async function sendAnalyticsEvent(name: string, params: { [key: string]: any }): Promise<void> {
  // Basic check for essential credentials
  if (
    !MEASUREMENT_ID ||
    !API_SECRET ||
    MEASUREMENT_ID === 'G-XXXXXXXXXX' /* Check for placeholder */ ||
    API_SECRET === 'YOUR_API_SECRET' /* Check for placeholder */
  ) {
    // Check if placeholders are still present or if env vars are missing
    console.warn(
      '[GA4] Analytics tracking is disabled. Ensure CEB_GA_MEASUREMENT_ID and CEB_GA_API_SECRET are set in your .env file and the build process is using them.',
    );
    return;
  }

  try {
    const clientId = await getOrCreateClientId();
    const sessionId = await getOrCreateSessionId();

    // Prepare the event payload
    const eventPayload = {
      name,
      params: {
        session_id: sessionId,
        engagement_time_msec: DEFAULT_ENGAGEMENT_TIME_IN_MSEC,
        ...params, // Spread user-provided params
      },
    };

    // Prepare the request body
    const requestBody = {
      client_id: clientId,
      events: [eventPayload],
    };

    // logMessage(`[GA4] Sending event: ${name}`, params);
    console.debug(`[GA4] Sending event: ${name}`, JSON.stringify(params)); // Stringify params for better logging

    const response = await fetch(`${API_ENDPOINT}?measurement_id=${MEASUREMENT_ID}&api_secret=${API_SECRET}`, {
      method: 'POST',
      body: JSON.stringify(requestBody),
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Check status code before attempting to parse body
    if (response.ok) {
      // Response is OK (2xx status code)
      console.debug('[GA4] Event sent successfully.');
      // Only try to parse body if it's not 204 No Content and in debug mode
      if (IS_DEV_MODE && response.status !== 204) {
        try {
          const successBody = await response.json();
          console.debug('[GA4] Debug endpoint success response:', JSON.stringify(successBody, null, 2));
        } catch (parseError) {
          console.debug('[GA4] Debug endpoint success response likely had no body (e.g., 200 OK with empty body).');
        }
      }
    } else {
      // Response is NOT OK (e.g., 4xx, 5xx)
      console.warn(`[GA4] Analytics request failed: ${response.status} ${response.statusText}`);
      // If using debug endpoint, try to log the response body for detailed errors
      if (IS_DEV_MODE) {
        try {
          const errorBody = await response.json();
          console.error('[GA4] Debug endpoint error response:', JSON.stringify(errorBody, null, 2));
        } catch (parseError) {
          console.error('[GA4] Debug endpoint error response could not be parsed as JSON:', await response.text()); // Log as text if JSON fails
        }
      }
    }
  } catch (error) {
    console.error('[GA4] Error sending analytics event:', error);
  }
}

// --- Specific Event Helpers (Optional but Recommended) ---

/**
 * Sends a 'page_view' event. Automatically includes title and location.
 * Call this from extension pages (popup, options, side panel) or content scripts if needed.
 */
export async function trackPageView(): Promise<void> {
  await sendAnalyticsEvent('page_view', {
    page_title: document.title,
    page_location: document.location.href,
  });
}

/**
 * Sends an 'extension_error' event for tracking issues.
 * @param error The error object.
 * @param context Additional context (e.g., 'background', 'content_script').
 */
export async function trackError(error: Error, context: string): Promise<void> {
  await sendAnalyticsEvent('extension_error', {
    error_message: error.message,
    error_stack: error.stack?.substring(0, 500), // Limit stack trace length
    error_context: context,
  });
}
