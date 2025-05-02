// pages/content/src/utils/backgroundCommunication.ts

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { mcpHandler } from '@src/utils/mcpHandler';
import type { Primitive, Tool, BackgroundCommunication, ServerConfig } from '@src/types/mcp';
import { logMessage } from '@src/utils/helpers';
import Ajv from 'ajv';

/**
 * Custom hook to handle communication with the background script via mcpHandler
 */
export const useBackgroundCommunication = (): BackgroundCommunication => {
  // Default config as a constant
  const DEFAULT_CONFIG: ServerConfig = { uri: 'http://localhost:3006/sse' };

  // State for server connection status
  const [serverStatus, setServerStatus] = useState<'connected' | 'disconnected' | 'error' | 'reconnecting'>(
    'disconnected',
  );
  // State for list of available tools
  const [availableTools, setAvailableTools] = useState<Tool[]>([]);
  // State to track if we're currently reconnecting
  const [isReconnecting, setIsReconnecting] = useState<boolean>(false);
  // Initialize server config with default value to prevent loading issues
  const [serverConfigCache, setServerConfigCache] = useState<ServerConfig>(DEFAULT_CONFIG);
  // Track if a config request is in progress
  const configRequestInProgressRef = useRef<boolean>(false);
  // Last fetch timestamp for throttling
  const lastConfigFetchRef = useRef<number>(0);
  // Track initialization status
  const isInitializedRef = useRef<boolean>(false);
  // Initialization complete
  const [isInitComplete, setIsInitComplete] = useState<boolean>(false);

  const ajv = useMemo(() => new Ajv(), []);

  // Preload the config on mount to ensure components can load
  useEffect(() => {
    const initializeConfig = async () => {
      try {
        logMessage('[Background Communication] Starting initial server config fetch');
        const config = await fetchServerConfig();
        setServerConfigCache(config);
        lastConfigFetchRef.current = Date.now();
      } catch (error) {
        logMessage(
          `[Background Communication] Error in initial config fetch: ${error instanceof Error ? error.message : String(error)}`,
        );
        // Keep using the default config that was set in useState
      } finally {
        setIsInitComplete(true);
        isInitializedRef.current = true;
      }
    };

    // Start initialization but don't await it
    initializeConfig();

    // Force completion after a timeout
    const timeoutId = setTimeout(() => {
      if (!isInitializedRef.current) {
        logMessage('[Background Communication] Force completing initialization after timeout');
        isInitializedRef.current = true;
        setIsInitComplete(true);
      }
    }, 2000);

    return () => clearTimeout(timeoutId);
  }, []);

  // Subscribe to connection status changes
  useEffect(() => {
    const handleConnectionStatus = (isConnected: boolean) => {
      // Only update if we're not in the middle of a manual reconnect
      if (!isReconnecting) {
        setServerStatus(isConnected ? 'connected' : 'disconnected');
      }
    };

    // Register the callback with mcpHandler
    mcpHandler.onConnectionStatusChanged(handleConnectionStatus);

    // Cleanup: Unregister the callback when the component unmounts
    return () => {
      mcpHandler.offConnectionStatusChanged(handleConnectionStatus);
    };
  }, [isReconnecting]);

  // Fetch available tools when the connection status changes to 'connected'
  useEffect(() => {
    if (serverStatus === 'connected') {
      getAvailableTools()
        .then(tools => setAvailableTools(tools))
        .catch(() => {
          setServerStatus('error');
          setAvailableTools([]);
        });
    } else if (serverStatus === 'disconnected' || serverStatus === 'error') {
      setAvailableTools([]);
    }
  }, [serverStatus]);

  // Set up a listener for broadcast tool updates
  useEffect(() => {
    // Create a callback function to handle broadcast tool updates
    const handleBroadcastToolUpdate = (primitives: Primitive[]) => {
      logMessage(`[Background Communication] Received broadcast tool update with ${primitives.length} primitives`);

      // Transform the primitives into Tool objects
      const tools: Tool[] = primitives
        .filter((primitive: Primitive) => primitive.type === 'tool')
        .map((primitive: Primitive) => ({
          name: primitive.value.name,
          description: primitive.value.description || '',
          schema: JSON.stringify(primitive.value.inputSchema || {}),
        }));

      logMessage(`[Background Communication] Updating available tools with ${tools.length} tools from broadcast`);

      // Update the state with the new tools
      setAvailableTools(tools);
    };

    // Register the callback with mcpHandler
    mcpHandler.onBroadcastToolUpdate(handleBroadcastToolUpdate);

    // Cleanup: Unregister the callback when the component unmounts
    return () => {
      mcpHandler.offBroadcastToolUpdate(handleBroadcastToolUpdate);
    };
  }, []);

  // Function to call an MCP tool
  const callTool = useCallback(
    async (toolName: string, args: { [key: string]: unknown }): Promise<any> => {
      // Schema validation for tool arguments
      const toolEntry = availableTools.find(t => t.name === toolName);
      if (toolEntry) {
        try {
          const schemaObj = JSON.parse(toolEntry.schema);
          const validate = ajv.compile(schemaObj);
          if (!validate(args)) {
            const errorText = ajv.errorsText(validate.errors);
            throw new Error(`Invalid arguments for ${toolName}: ${errorText}`);
          }
        } catch (e) {
          logMessage(
            `[Background Communication] Schema validation error for ${toolName}: ${e instanceof Error ? e.message : String(e)}`,
          );
          throw e;
        }
      }

      return new Promise((resolve, reject) => {
        mcpHandler.callTool(toolName, args, (result, error) => {
          if (error) {
            reject(new Error(error));
          } else {
            resolve(result);
          }
        });
      });
    },
    [availableTools, ajv],
  );

  // Function to fetch available tools from the MCP server
  const getAvailableTools = useCallback(async (): Promise<Tool[]> => {
    return new Promise((resolve, reject) => {
      // Use getAvailableToolPrimitives instead of getAvailableTools
      mcpHandler.getAvailableToolPrimitives((result, error) => {
        if (error) {
          reject(new Error(error));
        } else {
          // Transform the result into an array of Tool objects
          // Filter to only include primitives of type 'tool'
          const tools: Tool[] = result
            .filter((primitive: Primitive) => primitive.type === 'tool')
            .map((primitive: Primitive) => ({
              name: primitive.value.name,
              description: primitive.value.description || '',
              schema: JSON.stringify(primitive.value.inputSchema || {}),
            }));
          resolve(tools);
        }
      });
    });
  }, []);

  // Function to get server configuration with caching
  const getServerConfig = useCallback(async (): Promise<ServerConfig> => {
    // If initialization hasn't completed, return the current cache (which at minimum has the default)
    if (!isInitComplete) {
      return serverConfigCache;
    }

    // If we have a cached config and it's been less than 5 minutes since the last fetch, return it
    const now = Date.now();
    const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

    if (now - lastConfigFetchRef.current < CACHE_TTL) {
      // logMessage('[Background Communication] Using cached server configuration');
      return serverConfigCache;
    }

    // If there's already a request in progress, wait for it to complete
    if (configRequestInProgressRef.current) {
      // Wait for the current request to finish and update the cache
      let retryCount = 0;
      while (configRequestInProgressRef.current && retryCount < 10) {
        await new Promise(resolve => setTimeout(resolve, 100));
        retryCount++;
      }

      // Return current cache regardless
      return serverConfigCache;
    }

    try {
      const config = await fetchServerConfig();
      return config;
    } catch (error) {
      logMessage(`[Background Communication] Error fetching config, using current cache`);
      return serverConfigCache;
    }
  }, [serverConfigCache, isInitComplete]);

  // Extract the actual fetch logic to a separate function
  const fetchServerConfig = useCallback(async (): Promise<ServerConfig> => {
    // Mark that we're starting a request
    configRequestInProgressRef.current = true;

    try {
      // Set up a timeout promise to ensure we don't wait too long
      const timeoutPromise = new Promise<ServerConfig>(resolve => {
        setTimeout(() => {
          resolve(serverConfigCache); // Resolve with current cache on timeout
        }, 3000); // 3 second timeout
      });

      // Actual fetch promise
      const fetchPromise = new Promise<ServerConfig>((resolve, reject) => {
        try {
          mcpHandler.getServerConfig((result, error) => {
            if (error) {
              logMessage(`[Background Communication] Error getting server config: ${error}`);
              reject(new Error(error));
            } else {
              logMessage(`[Background Communication] Server config retrieved successfully`);
              resolve(result || DEFAULT_CONFIG);
            }
          });
        } catch (innerError) {
          reject(innerError);
        }
      });

      // Race between the fetch and the timeout
      const config = await Promise.race([fetchPromise, timeoutPromise]);

      // Update cache and timestamp
      setServerConfigCache(config);
      lastConfigFetchRef.current = Date.now();
      return config;
    } catch (error) {
      // If fetch fails, return current cache
      return serverConfigCache;
    } finally {
      // Mark request as complete
      configRequestInProgressRef.current = false;
    }
  }, [serverConfigCache]);

  // Function to update server configuration
  const updateServerConfig = useCallback(async (config: ServerConfig): Promise<boolean> => {
    logMessage(`[Background Communication] Updating server configuration: ${JSON.stringify(config)}`);

    return new Promise((resolve, reject) => {
      mcpHandler.updateServerConfig(config, (result, error) => {
        if (error) {
          logMessage(`[Background Communication] Error updating server config: ${error}`);
          reject(new Error(error));
        } else {
          logMessage(`[Background Communication] Server config updated successfully`);
          // Update cache when config is successfully updated
          setServerConfigCache(config);
          lastConfigFetchRef.current = Date.now();
          resolve(result?.success || false);
        }
      });
    });
  }, []);

  // Function to refresh the tools list
  const refreshTools = useCallback(
    async (forceRefresh: boolean = false): Promise<Tool[]> => {
      logMessage(`[Background Communication] Refreshing tools list (forceRefresh: ${forceRefresh})`);

      try {
        if (forceRefresh) {
          // If force refresh is requested, we'll first try to reconnect to ensure a fresh connection
          logMessage('[Background Communication] Force refresh requested, checking connection first');

          // Check if we're already connected
          const isConnected = mcpHandler.getConnectionStatus();
          if (!isConnected) {
            logMessage('[Background Communication] Not connected, attempting to reconnect before refreshing tools');
            // We don't want to use forceReconnect here as it would cause a loop
            // Just wait a moment and continue with the refresh
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }

        // Get available tools from the server with a fresh request
        logMessage('[Background Communication] Fetching tools from server with fresh request');

        // Use a new promise to ensure we get a fresh request
        const tools = await new Promise<Tool[]>((resolve, reject) => {
          // Generate a unique request ID to avoid any caching
          const uniqueRequestId = mcpHandler.getAvailableToolPrimitives((result, error) => {
            if (error) {
              logMessage(`[Background Communication] Error fetching tools: ${error}`);
              reject(new Error(error));
            } else {
              // Transform the result into an array of Tool objects
              // Filter to only include primitives of type 'tool'
              const tools: Tool[] = result
                .filter((primitive: Primitive) => primitive.type === 'tool')
                .map((primitive: Primitive) => ({
                  name: primitive.value.name,
                  description: primitive.value.description || '',
                  schema: JSON.stringify(primitive.value.inputSchema || {}),
                }));
              resolve(tools);
            }
          }, forceRefresh); // Pass forceRefresh parameter

          logMessage(
            `[Background Communication] Sent fresh tools request with ID: ${uniqueRequestId} (forceRefresh: ${forceRefresh})`,
          );
        });

        logMessage(`[Background Communication] Tools refreshed successfully, found ${tools.length} tools`);

        // Update the state with the new tools
        setAvailableTools(tools);
        return tools;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logMessage(`[Background Communication] Error refreshing tools: ${errorMessage}`);
        throw error;
      }
    },
    [getAvailableTools],
  );

  // Function to force reconnect to the MCP server
  const forceReconnect = useCallback(async (): Promise<boolean> => {
    logMessage('[Background Communication] Forcing reconnection to MCP server');
    setIsReconnecting(true);
    setServerStatus('reconnecting');

    return new Promise((resolve, reject) => {
      mcpHandler.forceReconnect((result, error) => {
        setIsReconnecting(false);

        if (error) {
          logMessage(`[Background Communication] Reconnection failed: ${error}`);
          setServerStatus('error');
          reject(new Error(error));
        } else {
          const isConnected = result?.isConnected || false;
          logMessage(`[Background Communication] Reconnection completed, connected: ${isConnected}`);
          setServerStatus(isConnected ? 'connected' : 'disconnected');

          // If connected, refresh the tools list with force refresh to ensure we get fresh data
          if (isConnected) {
            logMessage('[Background Communication] Connection successful, forcing tools refresh');
            getAvailableTools()
              .then(tools => {
                setAvailableTools(tools);
                logMessage(
                  `[Background Communication] Successfully refreshed ${tools.length} tools after reconnection`,
                );

                // Force a second refresh to ensure we have the latest tools from the new server
                return refreshTools(true);
              })
              .then(tools => {
                setAvailableTools(tools);
                logMessage(`[Background Communication] Second refresh completed, found ${tools.length} tools`);
                resolve(true);
              })
              .catch(refreshError => {
                logMessage(
                  `[Background Communication] Error refreshing tools: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
                );
                setServerStatus('error');
                setAvailableTools([]);
                resolve(false);
              });
          } else {
            setAvailableTools([]);
            resolve(false);
          }
        }
      });
    });
  }, [getAvailableTools, refreshTools]);

  // Function to send a message to execute a tool (used by sidebar components)
  const sendMessage = useCallback(
    async (tool: any): Promise<string> => {
      try {
        // Handle both standard tools and MCPTools
        let toolName = tool.name;
        let toolArgs = tool.args || {};

        // If it's an MCPTool (has toolName and rawArguments properties)
        if (tool.toolName && tool.rawArguments !== undefined) {
          toolName = tool.toolName;
          try {
            toolArgs = JSON.parse(tool.rawArguments);
          } catch (e) {
            console.error('Error parsing MCPTool arguments:', e);
            const errorMessage = e instanceof Error ? e.message : String(e);
            return `Error: Invalid JSON arguments: ${errorMessage}`;
          }
        }

        const result = await callTool(toolName, toolArgs);
        return typeof result === 'string' ? result : JSON.stringify(result);
      } catch (error) {
        console.error('Error executing tool:', error);
        // Safely handle error of unknown type
        const errorMessage = error instanceof Error ? error.message : String(error);
        return `Error: ${errorMessage}`;
      }
    },
    [callTool],
  );

  // Return the communication interface
  return {
    serverStatus,
    availableTools,
    callTool,
    getAvailableTools,
    sendMessage,
    refreshTools,
    forceReconnect,
    isReconnecting,
    getServerConfig,
    updateServerConfig,
  };
};
