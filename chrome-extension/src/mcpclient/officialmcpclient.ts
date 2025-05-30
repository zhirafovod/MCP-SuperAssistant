import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport, SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

// Define types for primitives
type PrimitiveType = 'resource' | 'tool' | 'prompt';
type PrimitiveValue = {
  name: string;
  description?: string;
  uri?: string;
  inputSchema?: any;
  arguments?: any[];
};
type Primitive = {
  type: PrimitiveType;
  value: PrimitiveValue;
};

// Define spinner type
interface Spinner {
  success: (message?: string) => void;
  error: (message: string) => void;
}

/**
 * Singleton class to manage a persistent connection to the MCP server
 */
class PersistentMcpClient {
  private static instance: PersistentMcpClient | null = null;
  private client: Client | null = null;
  private transport: Transport | null = null;
  private serverUrl: string = '';
  private isConnected: boolean = false;
  private connectionPromise: Promise<Client> | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 3; // Reduced from 5 to 3
  private reconnectDelay: number = 2000;
  private reconnectTimeoutId: NodeJS.Timeout | null = null;
  private lastConnectionCheck: number = 0;
  private connectionCheckInterval: number = 30000; // 30 seconds
  private primitives: Primitive[] | null = null;
  private primitivesLastFetched: number = 0;
  private primitivesMaxAge: number = 300000; // 5 minutes
  private lastConnectionError: string | null = null;
  private consecutiveFailures: number = 0;
  private maxConsecutiveFailures: number = 3;

  /**
   * Private constructor to enforce singleton pattern
   */
  private constructor() {
    console.log('[PersistentMcpClient] Initialized');
  }

  /**
   * Get the singleton instance of PersistentMcpClient
   */
  public static getInstance(): PersistentMcpClient {
    if (!PersistentMcpClient.instance) {
      PersistentMcpClient.instance = new PersistentMcpClient();
    }
    return PersistentMcpClient.instance;
  }

  /**
   * Connect to the MCP server
   * @param uri The URI of the MCP server
   * @returns Promise that resolves to the client instance
   */
  public async connect(uri: string): Promise<Client> {
    // Check if we've exceeded consecutive failures
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      const errorMsg = `Connection permanently failed after ${this.maxConsecutiveFailures} consecutive attempts. Last error: ${this.lastConnectionError}`;
      console.error(`[PersistentMcpClient] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    // If we're already connecting, return the existing promise
    if (this.connectionPromise && this.serverUrl === uri && this.isConnected) {
      return this.connectionPromise;
    }

    // If the URL has changed, disconnect first
    if (this.serverUrl !== uri && this.isConnected) {
      await this.disconnect();
    }

    this.serverUrl = uri;

    // Create a new connection promise
    this.connectionPromise = this.createConnection(uri);
    return this.connectionPromise;
  }

  /**
   * Create a connection to the MCP server
   * @param uri The URI of the MCP server
   * @returns Promise that resolves to the client instance
   */
  private async createConnection(uri: string): Promise<Client> {
    const spinner = createSpinner(`Connecting to MCP server at ${uri}...`);

    try {
      // Validate URI
      if (!uri || typeof uri !== 'string') {
        throw new Error('URI must be a non-empty string');
      }

      // Parse and validate the URI
      let baseUrl: URL;
      try {
        baseUrl = new URL(uri);
      } catch (error) {
        throw new Error(`Invalid URI: ${uri}`);
      }

      spinner.success(`URI validated: ${uri}`);

      // Try modern StreamableHTTP transport first, fall back to SSE
      spinner.success(`Attempting connection with backwards compatibility...`);
      
      let client: Client | undefined = undefined;
      let transport: Transport;
      
      try {
        // Try StreamableHTTP transport first (modern)
        console.log('1. Trying StreamableHTTP transport first...');
        client = new Client({
          name: 'streamable-http-client',
          version: '1.0.0'
        }, { capabilities: {} });
        
        // Set up notification handler
        client.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
          console.debug('[server log]:', notification.params.data);
        });
        
        transport = new StreamableHTTPClientTransport(baseUrl);
        await client.connect(transport);
        
        console.log('Successfully connected using StreamableHTTP transport');
        spinner.success(`Connected using modern StreamableHTTP transport`);
        
        this.client = client;
        this.transport = transport;
      } catch (streamableError) {
        // If StreamableHTTP fails, try the older SSE transport
        console.log(`StreamableHTTP connection failed: ${streamableError}`);
        console.log('2. Falling back to deprecated SSE transport...');
        
        try {
          client = new Client({
            name: 'sse-client',
            version: '1.0.0'
          }, { capabilities: {} });
          
          // Set up notification handler
          client.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
            console.debug('[server log]:', notification.params.data);
          });
          
          transport = new SSEClientTransport(baseUrl);
          await client.connect(transport);
          
          console.log('Successfully connected using SSE transport');
          spinner.success(`Connected using legacy SSE transport`);
          
          this.client = client;
          this.transport = transport;
        } catch (sseError) {
          console.error(`Failed to connect with either transport method:\n1. StreamableHTTP error: ${streamableError}\n2. SSE error: ${sseError}`);
          
          // Provide more specific error message based on the errors
          let specificError = 'Could not connect to server with any available transport method.';
          
          if (streamableError instanceof Error && sseError instanceof Error) {
            // Check for common connection issues
            if (streamableError.message.includes('404') || sseError.message.includes('404')) {
              specificError = 'MCP endpoints not found (404). The server is running but does not have MCP service endpoints available.';
            } else if (streamableError.message.includes('403') || sseError.message.includes('403')) {
              specificError = 'Access forbidden (403). Please check server permissions and authentication settings.';
            } else if (streamableError.message.includes('429') || sseError.message.includes('429') ||
                       streamableError.message.includes('HTTP 429') || sseError.message.includes('HTTP 429')) {
              specificError = 'Rate limited (429). The server is temporarily blocking requests due to too many attempts. Please wait a moment and try again.';
            } else if (streamableError.message.includes('405') || sseError.message.includes('405') ||
                       streamableError.message.includes('Method Not Allowed') || sseError.message.includes('Method Not Allowed')) {
              specificError = 'Method not allowed (405). The server is available but may have restrictions on HTTP methods. This is usually a temporary issue.';
            } else if (streamableError.message.includes('500') || sseError.message.includes('500') ||
                       streamableError.message.includes('502') || sseError.message.includes('502') ||
                       streamableError.message.includes('503') || sseError.message.includes('503')) {
              specificError = 'Server error detected. The MCP server may be experiencing issues.';
            } else if (streamableError.message.includes('timeout') || sseError.message.includes('timeout')) {
              specificError = 'Connection timeout. The server may be slow to respond or the MCP endpoints are not accessible.';
            }
          }
          
          throw new Error(specificError);
        }
      }

      // Reset reconnect attempts on successful connection
      this.reconnectAttempts = 0;
      this.consecutiveFailures = 0;
      this.lastConnectionError = null;
      this.isConnected = true;
      this.lastConnectionCheck = Date.now();

      spinner.success(`Connected to MCP server`);
      return this.client;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Enhanced error categorization for better user feedback
      let enhancedErrorMessage = errorMessage;
      if (errorMessage.includes('404') || errorMessage.includes('404 page not found')) {
        enhancedErrorMessage = 'Server URL not found (404). Please check if the MCP server is running at the correct URL and verify the server configuration.';
      } else if (errorMessage.includes('403')) {
        enhancedErrorMessage = 'Access forbidden (403). Please check server permissions and authentication settings.';
      } else if (errorMessage.includes('429') || errorMessage.includes('HTTP 429')) {
        enhancedErrorMessage = 'Rate limited (429). The server is temporarily blocking requests due to too many attempts. Please wait a moment and try again.';
      } else if (errorMessage.includes('405') || errorMessage.includes('Method Not Allowed')) {
        enhancedErrorMessage = 'Method not allowed (405). The server is available but may not support the requested HTTP method. This is usually a temporary issue.';
      } else if (errorMessage.includes('500') || errorMessage.includes('502') || errorMessage.includes('503')) {
        enhancedErrorMessage = 'Server error detected. The MCP server may be experiencing issues. Please try again later or contact your server administrator.';
      } else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('Connection refused')) {
        enhancedErrorMessage = 'Connection refused. Please verify the MCP server is running and accessible at the configured URL.';
      } else if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
        enhancedErrorMessage = 'Connection timeout. The server may be slow to respond or unreachable. Please check your network connection and server status.';
      } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo ENOTFOUND')) {
        enhancedErrorMessage = 'Server not found. Please check the server URL and your network connection.';
      } else if (errorMessage.includes('Could not connect to server with any available transport')) {
        enhancedErrorMessage = 'Unable to establish connection using any available method. Please verify the server URL and ensure the MCP server is running and accessible.';
      } else if (errorMessage.includes('MCP endpoints not found')) {
        enhancedErrorMessage = 'MCP endpoints not found (404). The server is running but does not have MCP service endpoints available. Please verify this is an MCP server.';
      } else if (errorMessage.includes('MCP server may be experiencing issues')) {
        enhancedErrorMessage = 'The MCP server is experiencing internal errors. Please check server logs or contact the server administrator.';
      } else if (errorMessage.includes('MCP endpoints are not accessible')) {
        enhancedErrorMessage = 'MCP service endpoints are not accessible. The server is running but MCP services may not be properly configured.';
      }
      
      this.lastConnectionError = enhancedErrorMessage;
      this.consecutiveFailures++;
      
      spinner.error(enhancedErrorMessage);
      this.isConnected = false;

      // Log the failure count with enhanced message
      console.error(`[PersistentMcpClient] Connection attempt ${this.consecutiveFailures}/${this.maxConsecutiveFailures} failed: ${enhancedErrorMessage}`);

      // Create a new error with the enhanced message
      const enhancedError = new Error(enhancedErrorMessage);
      enhancedError.stack = error instanceof Error ? error.stack : undefined;
      
      // Don't schedule reconnect - all reconnection is user-driven
      throw enhancedError;
    }
  }

  /**
   * Disconnect from the MCP server
   */
  public async disconnect(): Promise<void> {
    if (this.client && this.isConnected) {
      const spinner = createSpinner(`Disconnecting from MCP server...`);
      try {
        await this.client.close();
        this.isConnected = false;
        this.client = null;
        this.transport = null;
        this.connectionPromise = null;
        spinner.success(`Disconnected from MCP server`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        spinner.error(errorMessage);
        // Force reset connection state even if disconnect fails
        this.isConnected = false;
        this.client = null;
        this.transport = null;
        this.connectionPromise = null;
      }
    }

    // Clear any pending reconnect
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
  }

  /**
   * Schedule a reconnection attempt
   * CRITICAL: No automatic reconnection - all reconnection is user-driven
   */
  private scheduleReconnect(): void {
    // Clear any existing reconnect timeout
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
    
    // Log that we're not automatically reconnecting
    console.log('[PersistentMcpClient] No automatic reconnection - reconnection is user-driven only');
    
    // Reset reconnect attempts counter to ensure we don't hit the max limit
    // This allows user-initiated reconnects to always work
    this.reconnectAttempts = 0;
    
    // Do not schedule any automatic reconnection
    // All reconnection must be explicitly initiated by the user through the UI
  }

  /**
   * Check if the connection is still valid and reconnect if needed
   * @returns Promise that resolves to the client instance
   */
  public async ensureConnection(): Promise<Client> {
    // If we've never connected, throw an error
    if (!this.serverUrl) {
      throw new Error('No server URL set, call connect() first');
    }

    // Check if we've exceeded consecutive failures
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      throw new Error(`Connection permanently failed after ${this.maxConsecutiveFailures} consecutive attempts. Last error: ${this.lastConnectionError}`);
    }

    // If we're already connected and it's been less than connectionCheckInterval since the last check, return the client
    if (this.isConnected && this.client && Date.now() - this.lastConnectionCheck < this.connectionCheckInterval) {
      return this.client;
    }

    // If we're not connected or it's been too long since the last check, reconnect
    this.connectionPromise = this.createConnection(this.serverUrl);
    return this.connectionPromise;
  }

  /**
   * Call a tool using the persistent connection
   * @param toolName The name of the tool to call
   * @param args The arguments to pass to the tool
   * @returns Promise that resolves to the result of the tool call
   */
  public async callTool(toolName: string, args: { [key: string]: unknown }): Promise<any> {
    const spinner = createSpinner(`Calling tool ${toolName}...`);

    try {
      // Ensure we have a valid connection
      const client = await this.ensureConnection();

      // Validate arguments
      if (!toolName || typeof toolName !== 'string') {
        throw new Error('Tool name must be a non-empty string');
      }

      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('Arguments must be an object with string keys');
      }

      // Call the tool
      console.log('Args: ', args);
      const result = await client.callTool({ name: toolName, arguments: args });
      spinner.success(`Tool ${toolName} called successfully`);
      prettyPrint(result);

      // Update last connection check time
      this.lastConnectionCheck = Date.now();

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      spinner.error(errorMessage);

      // If there was an error, the connection might be invalid
      this.isConnected = false;

      throw error;
    }
  }

  /**
   * Get all primitives using the persistent connection
   * @returns Promise that resolves to an array of primitives
   */
  public async getPrimitives(): Promise<Primitive[]> {
    // If we have cached primitives and they're not too old, return them
    if (
      this.primitives &&
      this.primitivesLastFetched &&
      Date.now() - this.primitivesLastFetched < this.primitivesMaxAge
    ) {
      return this.primitives;
    }

    const spinner = createSpinner(`Retrieving primitives...`);

    try {
      // Ensure we have a valid connection
      const client = await this.ensureConnection();

      // Get primitives
      spinner.success(`Retrieving primitives...`);
      const primitives = await listPrimitives(client);
      spinner.success(`Retrieved ${primitives.length} primitives`);

      // Cache primitives
      this.primitives = primitives;
      this.primitivesLastFetched = Date.now();

      // Update last connection check time
      this.lastConnectionCheck = Date.now();

      return primitives;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      spinner.error(errorMessage);

      // If there was an error, the connection might be invalid
      this.isConnected = false;

      throw error;
    }
  }

  /**
   * Get the connection status
   * @returns True if connected, false otherwise
   */
  public getConnectionStatus(): boolean {
    // For most calls, just return the current status without triggering checks
    // This prevents excessive network requests and false negatives
    
    // Only trigger a background check if we haven't checked in a very long time (60 seconds)
    const timeSinceLastCheck = Date.now() - this.lastConnectionCheck;
    if (timeSinceLastCheck > 60000) {
      // Don't wait for the promise to resolve, just trigger the check in background
      this.checkConnectionStatus().catch(error => {
        console.error('[PersistentMcpClient] Background connection check failed:', error);
      });
    }
    
    console.log(`[PersistentMcpClient] getConnectionStatus: ${this.isConnected} (last check: ${timeSinceLastCheck}ms ago)`);
    return this.isConnected;
  }

  /**
   * Actively check if the server is still available
   * This is an async method that updates the isConnected flag
   */
  private async checkConnectionStatus(): Promise<boolean> {
    try {
      // If we don't have a server URL, we're not connected
      if (!this.serverUrl) {
        this.isConnected = false;
        return false;
      }

      // If we don't have an active client, we're definitely not connected
      if (!this.client) {
        this.isConnected = false;
        return false;
      }

      // For periodic connection checks, we should be conservative
      // Only mark as disconnected if we have clear evidence of connection failure
      // The client itself tracks connection state, so we trust that unless proven otherwise
      
      // Don't call isServerAvailable for periodic checks as it may give false negatives
      // The MCP client maintains its own connection state which is more reliable
      console.log(`[PersistentMcpClient] Connection check: client exists and marked as connected`);
      
      // Update the last check time
      this.lastConnectionCheck = Date.now();

      // Return the current connection state without changing it
      // Only actual connection errors should change this state
      return this.isConnected;
    } catch (error) {
      console.error(`[PersistentMcpClient] Error during connection status check:`, error);
      // Don't change connection status on check errors
      this.lastConnectionCheck = Date.now();
      return this.isConnected;
    }
  }

  /**
   * Force a reconnection to the MCP server
   * @param uri Optional new URI - if provided, will update the server URL before reconnecting
   */
  public async forceReconnect(uri?: string): Promise<void> {
    // Reset failure counters to allow user-initiated reconnects
    this.consecutiveFailures = 0;
    this.lastConnectionError = null;
    
    // Clear the primitives cache to ensure we get fresh data from the new server
    this.clearCache();

    // Disconnect first
    await this.disconnect();
    
    // If a new URI is provided, update the server URL
    if (uri) {
      this.serverUrl = uri;
    }
    
    // Reconnect with the current (possibly updated) server URL
    if (this.serverUrl) {
      await this.connect(this.serverUrl);
    }
  }

  /**
   * Clear the primitives cache to ensure we get fresh data from the server
   */
  public clearCache(): void {
    console.log('[PersistentMcpClient] Clearing primitives cache');
    this.primitives = null;
    this.primitivesLastFetched = 0;
  }

  /**
   * Get the server URL
   */
  public getServerUrl(): string {
    return this.serverUrl;
  }

  /**
   * Get the client instance
   */
  public getClient(): Client | null {
    return this.client;
  }
}

/**
 * Creates a simple spinner for console feedback
 * @param text The text to display with the spinner
 * @returns A spinner object with success and error methods
 */
function createSpinner(text: string): Spinner {
  console.log(`⏳ ${text}`);
  return {
    success: (message?: string) => {
      console.log(`✅ ${message || text} completed`);
    },
    error: (message: string) => {
      console.error(`❌ ${text} failed: ${message}`);
    },
  };
}

/**
 * Pretty prints an object to the console
 * @param obj The object to print
 */
function prettyPrint(obj: any): void {
  console.log(JSON.stringify(obj, null, 2));
}

/**
 * Utility function to check if an MCP server is available at the specific endpoint
 * @param url The complete MCP URL to check (including endpoint path)
 * @param requiresActiveClient Whether to require an active client connection (default: false)
 * @returns Promise that resolves to true if MCP server is available at this endpoint, false otherwise
 */
async function isServerAvailable(url: string, requiresActiveClient: boolean = false): Promise<boolean> {
  // If requiresActiveClient is true, check if we have an active client connection
  // and verify the hostname is still reachable
  if (requiresActiveClient) {
    // First check if we have an active client connection
    const hasActiveClient = persistentClient.getConnectionStatus() && !!persistentClient.getClient();
    if (!hasActiveClient) {
      return false;
    }

    // If we have an active client, verify the hostname/domain is still reachable
    // This provides a basic connectivity check without testing the specific MCP endpoint
    try {
      const parsedUrl = new URL(url);
      const baseUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}${parsedUrl.port ? ':' + parsedUrl.port : ''}`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000); // Shorter timeout for hostname check

      try {
        const response = await fetch(baseUrl, {
          method: 'HEAD',
          signal: controller.signal,
          mode: 'no-cors' // Use no-cors for basic connectivity check
        });
        
        console.log(`Hostname ${baseUrl} is reachable for active client`);
        return true;
      } catch (fetchError) {
        const errorMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);
        
        // For no-cors requests, most responses will throw, so we need to be more lenient
        if (errorMessage.includes('ECONNREFUSED') || 
            errorMessage.includes('ENOTFOUND') ||
            errorMessage.includes('ERR_INTERNET_DISCONNECTED')) {
          console.log(`Hostname ${baseUrl} is not reachable: ${errorMessage}`);
          return false;
        } else {
          // Other errors might indicate the server is actually reachable
          console.log(`Hostname ${baseUrl} appears reachable despite error: ${errorMessage}`);
          return true;
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      console.log(`Error checking hostname availability for active client: ${error}`);
      return false;
    }
  }

  try {
    // Parse the URL to get hostname and port
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname;
    const port = parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80');
    
    // Create an abort controller with timeout to prevent long waits
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout

    try {
      // Check the exact MCP endpoint, not just the hostname
      // This is more accurate for MCP availability
      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        mode: 'cors' // Use CORS since MCP requires it
      });

      // Check for successful responses or expected MCP-related status codes
      if (response.ok || response.status === 200) {
        console.log(`MCP endpoint ${url} is available (status: ${response.status})`);
        return true;
      } else if (response.status === 405) {
        // Method not allowed usually means the endpoint exists but doesn't support HEAD
        // This is common for MCP endpoints
        console.log(`MCP endpoint ${url} exists but doesn't support HEAD (405) - considering available`);
        return true;
      } else if (response.status === 404) {
        console.log(`MCP endpoint ${url} not found (404) - not available`);
        return false;
      } else if (response.status === 403) {
        console.log(`MCP endpoint ${url} forbidden (403) - considering unavailable`);
        return false;
      } else if (response.status >= 500) {
        console.log(`MCP endpoint ${url} server error (${response.status}) - considering unavailable`);
        return false;
      } else {
        // For other status codes, be conservative and consider available
        console.log(`MCP endpoint ${url} returned status ${response.status} - considering available`);
        return true;
      }
    } catch (fetchError) {
      const errorMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);
      
      // Network-level errors indicate the endpoint is not available
      if (errorMessage.includes('Failed to fetch') || 
          errorMessage.includes('NetworkError') ||
          errorMessage.includes('ECONNREFUSED') ||
          errorMessage.includes('ENOTFOUND') ||
          errorMessage.includes('CORS error') ||
          errorMessage.includes('ERR_INTERNET_DISCONNECTED')) {
        console.log(`MCP endpoint ${url} is not reachable: ${errorMessage}`);
        return false;
      } else {
        // For other errors, be conservative and consider the endpoint potentially available
        console.log(`MCP endpoint ${url} check failed with non-network error: ${errorMessage} - considering potentially available`);
        return true;
      }
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    // This catch block handles URL parsing errors and other issues
    console.log(`Error checking MCP endpoint availability for ${url}:`, error);
    return false;
  }
}


async function listPrimitives(client: Client): Promise<Primitive[]> {
  const capabilities = client.getServerCapabilities() as ServerCapabilities;
  const primitives: Primitive[] = [];
  const promises: Promise<void>[] = [];

  if (capabilities.resources) {
    promises.push(
      client.listResources().then(({ resources }) => {
        resources.forEach(item => primitives.push({ type: 'resource', value: item }));
      }),
    );
  }
  if (capabilities.tools) {
    promises.push(
      client.listTools().then(({ tools }) => {
        tools.forEach(item => primitives.push({ type: 'tool', value: item }));
      }),
    );
  }
  if (capabilities.prompts) {
    promises.push(
      client.listPrompts().then(({ prompts }) => {
        prompts.forEach(item => primitives.push({ type: 'prompt', value: item }));
      }),
    );
  }
  await Promise.all(promises);
  return primitives;
}

// Get the persistent client instance
const persistentClient = PersistentMcpClient.getInstance();

/**
 * Call a tool on the MCP server using backwards compatible connection
 * @param uri The URI of the MCP server
 * @param toolName The name of the tool to call
 * @param args The arguments to pass to the tool as an object with string keys
 * @returns Promise that resolves to the result of the tool call
 */
export async function callToolWithBackwardsCompatibility(uri: string, toolName: string, args: { [key: string]: unknown }): Promise<any> {
  try {
    // Connect to the server if not already connected (with backwards compatibility)
    await persistentClient.connect(uri);

    // Call the tool using the persistent connection
    return await persistentClient.callTool(toolName, args);
  } catch (error) {
    console.error(`Error calling tool ${toolName}:`, error);
    throw error;
  }
}

/**
 * Legacy alias for backwards compatibility
 * @deprecated Use callToolWithBackwardsCompatibility instead
 */
export async function callToolWithSSE(uri: string, toolName: string, args: { [key: string]: unknown }): Promise<any> {
  return callToolWithBackwardsCompatibility(uri, toolName, args);
}

/**
 * Get all primitives from the MCP server using backwards compatible connection
 * @param uri The URI of the MCP server
 * @param forceRefresh Whether to force a refresh and ignore the cache
 * @returns Promise that resolves to an array of primitives (resources, tools, and prompts)
 */
export async function getPrimitivesWithBackwardsCompatibility(uri: string, forceRefresh: boolean = false): Promise<Primitive[]> {
  try {
    // Connect to the server if not already connected (with backwards compatibility)
    await persistentClient.connect(uri);

    // Clear cache if force refresh is requested
    if (forceRefresh) {
      console.log('[getPrimitivesWithBackwardsCompatibility] Force refresh requested, clearing cache');
      persistentClient.clearCache();
    }

    // Get primitives using the persistent connection
    return await persistentClient.getPrimitives();
  } catch (error) {
    console.error('Error getting primitives:', error);
    throw error;
  }
}

/**
 * Legacy alias for backwards compatibility
 * @deprecated Use getPrimitivesWithBackwardsCompatibility instead
 */
export async function getPrimitivesWithSSE(uri: string, forceRefresh: boolean = false): Promise<Primitive[]> {
  return getPrimitivesWithBackwardsCompatibility(uri, forceRefresh);
}

/**
 * Check if the MCP server is connected
 * @returns True if connected, false otherwise
 */
export function isMcpServerConnected(): boolean {
  return persistentClient.getConnectionStatus();
}

/**
 * Actively check the MCP server connection status
 * This performs a real-time check of the server availability
 * @returns Promise that resolves to true if connected, false otherwise
 */
export async function checkMcpServerConnection(): Promise<boolean> {
  try {
    // First check if we have a client and it's marked as connected
    const hasClient = !!persistentClient.getClient();
    const isMarkedConnected = persistentClient.getConnectionStatus();
    
    console.log(`[checkMcpServerConnection] hasClient: ${hasClient}, isMarkedConnected: ${isMarkedConnected}`);
    
    if (!hasClient || !isMarkedConnected) {
      console.log(`[checkMcpServerConnection] No client or not marked connected, returning false`);
      return false;
    }

    // Get the server URL
    const serverUrl = persistentClient.getServerUrl();
    if (!serverUrl) {
      console.log(`[checkMcpServerConnection] No server URL, returning false`);
      return false;
    }

    // For a quick connection check, we trust the internal state
    // The client connection state is more reliable than external HTTP checks
    // because the MCP connection is persistent and the client tracks its own state
    const connectionStatus = persistentClient.getConnectionStatus();
    console.log(`[checkMcpServerConnection] Final connection status: ${connectionStatus}`);
    
    return connectionStatus;
  } catch (error) {
    console.error('Error checking MCP server connection:', error);
    return false;
  }
}

/**
 * Force a reconnection to the MCP server
 * @param uri The URI of the MCP server
 * @returns Promise that resolves when reconnection is complete
 */
export async function forceReconnectToMcpServer(uri: string): Promise<void> {
  // Reset all client state for the new URL
  await persistentClient.forceReconnect(uri);
}

/**
 * Call a tool with the given name and arguments
 * @param client The MCP client instance
 * @param toolName The name of the tool to call
 * @param args The arguments to pass to the tool as an object with string keys
 * @returns Promise that resolves to the result of the tool call
 */
async function callTool(client: Client, toolName: string, args: { [key: string]: unknown }): Promise<any> {
  const spinner = createSpinner(`Calling tool ${toolName}...`);
  try {
    if (!client) {
      throw new Error('Client is not initialized');
    }

    if (!toolName || typeof toolName !== 'string') {
      throw new Error('Tool name must be a non-empty string');
    }

    // Validate arguments
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('Arguments must be an object with string keys');
    }

    const result = await client.callTool({ name: toolName, arguments: args });
    spinner.success(`Tool ${toolName} called successfully`);
    prettyPrint(result);
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    spinner.error(errorMessage);
    throw error;
  }
}

/**
 * Run the MCP client with backwards compatibility
 * This function is used by the background script to initialize the connection
 * It tries StreamableHTTP transport first, then falls back to SSE transport
 * @param uri The URI of the MCP server
 * @returns Promise that resolves when the connection is established
 */
export async function runWithBackwardsCompatibility(uri: string): Promise<void> {
  try {
    console.log(`Attempting to connect to MCP server with backwards compatibility: ${uri}`);

    // Connect to the server using the persistent client (with backwards compatibility)
    await persistentClient.connect(uri);

    // Get primitives to verify the connection works
    const primitives = await persistentClient.getPrimitives();
    console.log(`Connected, found ${primitives.length} primitives`);

    // Log the primitives for debugging
    primitives.forEach(p => {
      console.log(`${p.type}: ${p.value.name} - ${p.value.description || 'No description'}`);
    });

    // Don't disconnect - keep the connection open
    return;
  } catch (error) {
    console.error('Error in MCP connection setup:', error);
    throw error;
  }
}

/**
 * Legacy alias for backwards compatibility
 * @deprecated Use runWithBackwardsCompatibility instead
 */
export async function runWithSSE(uri: string): Promise<void> {
  return runWithBackwardsCompatibility(uri);
}

// Export the callTool function for direct use
export { callTool, prettyPrint, createSpinner, listPrimitives };
