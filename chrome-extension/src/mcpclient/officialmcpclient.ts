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

      // Check server availability using the complete URL provided by the user
      spinner.success(`Checking if MCP server at ${uri} is available...`);
      const isAvailable = await isServerAvailable(uri);
      if (!isAvailable) {
        throw new Error(`MCP server at ${uri} is not available.`);
      }
      spinner.success(`MCP server at ${uri} is available`);

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
    // If we haven't checked the connection in a while, do a quick check
    const timeSinceLastCheck = Date.now() - this.lastConnectionCheck;
    if (timeSinceLastCheck > 5000) {
      // 5 seconds
      // Don't wait for the promise to resolve, just trigger the check
      this.checkConnectionStatus();
    }
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

      // Check if the server is available using the complete URL
      const isAvailable = await isServerAvailable(this.serverUrl);

      // Update the connection status
      const wasConnected = this.isConnected;
      this.isConnected = isAvailable;

      // If the status changed, log it
      if (wasConnected !== this.isConnected) {
        console.log(`[PersistentMcpClient] Connection status changed: ${this.isConnected}`);

        // If we were connected but now we're not, schedule a reconnect
        if (wasConnected && !this.isConnected) {
          this.scheduleReconnect();
        }
      }

      // Update the last check time
      this.lastConnectionCheck = Date.now();

      return this.isConnected;
    } catch (error) {
      // If there was an error, we're not connected
      this.isConnected = false;
      this.lastConnectionCheck = Date.now();
      return false;
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
 * Utility function to check if a server is available
 * @param url The URL to check - this should be the exact URL provided by the user
 * @returns Promise that resolves to true if server is available, false otherwise
 */
async function isServerAvailable(url: string): Promise<boolean> {
  try {
    // Create an abort controller with timeout to prevent long waits
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      // Always use CORS for MCP communication - CORS must be enabled for proper MCP functionality
      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        // Don't set mode: 'no-cors' - we need CORS for MCP communication
      });

      // Check the actual response status
      if (response.ok || response.status === 200) {
        console.log(`Server at ${url} is available (status: ${response.status})`);
        return true;
      } else if (response.status === 404) {
        console.log(`Server at ${url} is not available (404 - URL not found)`);
        return false;
      } else if (response.status === 403) {
        console.log(`Server at ${url} returned 403 (forbidden) - considering unavailable`);
        return false;
      } else if (response.status === 429) {
        console.log(`Server at ${url} returned 429 (rate limited) - considering available but with rate limiting`);
        return true; // Rate limiting means server is available, just busy
      } else if (response.status === 405) {
        console.log(`Server at ${url} returned 405 (method not allowed) - considering available`);
        return true; // Method not allowed for HEAD, but server is responsive
      } else if (response.status >= 500) {
        console.log(`Server at ${url} returned server error (status: ${response.status}) - considering unavailable`);
        return false;
      } else {
        // For other status codes, the server is available but may not support HEAD
        console.log(`Server at ${url} returned status ${response.status} - considering available`);
        return true;
      }
    } catch (fetchError) {
      // Any fetch error (including CORS errors) means the server is not available for MCP communication
      console.log(`Server at ${url} is not available (fetch failed): ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    // This catch block handles any other errors that might occur
    console.log(`Error checking server availability at ${url}:`, error);
    return false;
  }
}

async function createClient(): Promise<Client> {
  const client = new Client({ name: 'mcp-cli', version: '1.0.0' }, { capabilities: {} });
  client.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
    console.debug('[server log]:', notification.params.data);
  });
  return client;
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
    // If we don't have a client or it's not connected, return false
    if (!persistentClient.getConnectionStatus()) {
      return false;
    }

    // Get the server URL (this is the complete URL provided by the user)
    const serverUrl = persistentClient.getServerUrl();
    if (!serverUrl) {
      return false;
    }

    // Check if the server is available using the complete URL
    return await isServerAvailable(serverUrl);
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

    // First check if the complete URL is available before attempting to connect
    const isAvailable = await isServerAvailable(uri);

    if (!isAvailable) {
      throw new Error(`MCP server at ${uri} is not available`);
    }

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
