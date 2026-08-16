package service

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
)

const (
	mcpTransportHTTP      = "streamable_http"
	mcpTransportStdio     = "stdio"
	mcpProcessIdleTimeout = 10 * time.Minute
)

var stdioMCPManager = newStdioMCPProcessManager()

func callMCPServer(ctx context.Context, server model.MCPServer, method string, params map[string]any) (map[string]any, error) {
	switch strings.ToLower(strings.TrimSpace(server.Transport)) {
	case mcpTransportStdio:
		return stdioMCPManager.call(ctx, server, method, params)
	case "", mcpTransportHTTP:
		return callStreamableHTTPMCP(ctx, server, method, params)
	default:
		return nil, fmt.Errorf("不支持的 MCP 传输方式：%s", server.Transport)
	}
}

func callStreamableHTTPMCP(ctx context.Context, server model.MCPServer, method string, params map[string]any) (map[string]any, error) {
	request := func(sessionID string, rpcMethod string, rpcParams map[string]any) (map[string]any, string, error) {
		body, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"id":      time.Now().UnixNano(),
			"method":  rpcMethod,
			"params":  rpcParams,
		})
		httpRequest, err := newMCPHTTPClientRequest(ctx, server, body)
		if err != nil {
			return nil, "", err
		}
		if sessionID != "" {
			httpRequest.Header.Set("Mcp-Session-Id", sessionID)
		}
		response, err := mcpHTTPClient.Do(httpRequest)
		if err != nil {
			return nil, "", err
		}
		defer response.Body.Close()
		responseBody, _ := io.ReadAll(io.LimitReader(response.Body, 8<<20))
		if response.StatusCode >= 400 {
			return nil, "", readChannelError(string(responseBody), "MCP HTTP 请求失败")
		}
		if response.StatusCode == 202 || len(bytes.TrimSpace(responseBody)) == 0 {
			return map[string]any{}, response.Header.Get("Mcp-Session-Id"), nil
		}
		var payload map[string]any
		if err := decodeMCPJSON(responseBody, &payload); err != nil {
			return nil, "", err
		}
		return payload, response.Header.Get("Mcp-Session-Id"), nil
	}

	sessionID := ""
	if method != "initialize" {
		if _, sessionID, _ = request("", "initialize", map[string]any{
			"protocolVersion": "2025-06-18",
			"capabilities":    map[string]any{},
			"clientInfo":      map[string]any{"name": "infinite-canvas", "version": "1.0"},
		}); sessionID != "" {
			_, _, _ = request(sessionID, "notifications/initialized", map[string]any{})
		}
	}
	payload, nextSessionID, err := request(sessionID, method, params)
	if err != nil && sessionID != "" {
		payload, nextSessionID, err = request("", method, params)
	}
	if err != nil {
		return nil, err
	}
	if nextSessionID != "" {
		payload["mcpSessionId"] = nextSessionID
	}
	return payload, nil
}

func newMCPHTTPClientRequest(ctx context.Context, server model.MCPServer, body []byte) (*http.Request, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSpace(server.Endpoint), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	if strings.TrimSpace(server.APIKey) != "" {
		request.Header.Set("Authorization", "Bearer "+server.APIKey)
	}
	return request, nil
}

var mcpHTTPClient = &http.Client{Timeout: 120 * time.Second}

type stdioMCPProcessManager struct {
	mu      sync.Mutex
	clients map[string]*stdioMCPClient
	once    sync.Once
}

func newStdioMCPProcessManager() *stdioMCPProcessManager {
	return &stdioMCPProcessManager{clients: map[string]*stdioMCPClient{}}
}

func (manager *stdioMCPProcessManager) call(ctx context.Context, server model.MCPServer, method string, params map[string]any) (map[string]any, error) {
	manager.startReaper()
	client, err := manager.client(server)
	if err != nil {
		return nil, err
	}
	result, err := client.call(ctx, method, params)
	if err == nil {
		return result, nil
	}
	manager.remove(stdioServerKey(server), client)
	client.close()
	client, err = manager.client(server)
	if err != nil {
		return nil, err
	}
	return client.call(ctx, method, params)
}

func (manager *stdioMCPProcessManager) client(server model.MCPServer) (*stdioMCPClient, error) {
	key := stdioServerKey(server)
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if existing := manager.clients[key]; existing != nil && existing.matches(server) {
		existing.touch()
		return existing, nil
	}
	if existing := manager.clients[key]; existing != nil {
		existing.close()
		delete(manager.clients, key)
	}
	client, err := startStdioMCPClient(server)
	if err != nil {
		return nil, err
	}
	manager.clients[key] = client
	return client, nil
}

func (manager *stdioMCPProcessManager) remove(key string, client *stdioMCPClient) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.clients[key] == client {
		delete(manager.clients, key)
	}
}

func (manager *stdioMCPProcessManager) startReaper() {
	manager.once.Do(func() {
		go func() {
			ticker := time.NewTicker(time.Minute)
			defer ticker.Stop()
			for range ticker.C {
				manager.mu.Lock()
				for key, client := range manager.clients {
					if time.Since(client.lastUsedAt()) > mcpProcessIdleTimeout {
						client.close()
						delete(manager.clients, key)
					}
				}
				manager.mu.Unlock()
			}
		}()
	})
}

type stdioMCPClient struct {
	serverKey   string
	signature   string
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	reader      *bufio.Reader
	mu          sync.Mutex
	nextID      atomic.Int64
	lastUsed    atomic.Int64
	initialized bool
}

func startStdioMCPClient(server model.MCPServer) (*stdioMCPClient, error) {
	command := strings.TrimSpace(server.Command)
	if command == "" {
		return nil, errors.New("stdio MCP 缺少 command")
	}
	cmd := exec.Command(command, server.Args...)
	cmd.Dir = strings.TrimSpace(server.WorkingDir)
	if cmd.Dir == "" {
		cmd.Dir = ""
	}
	cmd.Env = os.Environ()
	for key, value := range server.Env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	cmd.Stderr = log.Writer()
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return nil, err
	}
	client := &stdioMCPClient{
		serverKey: server.ID,
		signature: stdioServerSignature(server),
		cmd:       cmd,
		stdin:     stdin,
		reader:    bufio.NewReader(stdout),
	}
	client.touch()
	return client, nil
}

func (client *stdioMCPClient) matches(server model.MCPServer) bool {
	return client.signature == stdioServerSignature(server)
}

func (client *stdioMCPClient) call(ctx context.Context, method string, params map[string]any) (map[string]any, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.touch()
	if !client.initialized && method != "initialize" {
		payload, err := client.callRaw(ctx, "initialize", map[string]any{
			"protocolVersion": "2025-06-18",
			"capabilities":    map[string]any{},
			"clientInfo":      map[string]any{"name": "infinite-canvas", "version": "1.0"},
		})
		if err != nil {
			return nil, err
		}
		if rpcError, ok := payload["error"].(map[string]any); ok {
			return nil, fmt.Errorf("MCP 初始化失败：%v", rpcError["message"])
		}
		if err := client.notify("notifications/initialized", map[string]any{}); err != nil {
			return nil, err
		}
		client.initialized = true
	}
	return client.callRaw(ctx, method, params)
}

func (client *stdioMCPClient) callRaw(ctx context.Context, method string, params map[string]any) (map[string]any, error) {
	id := client.nextID.Add(1)
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if _, err := client.stdin.Write(append(body, '\n')); err != nil {
		return nil, err
	}
	for {
		line, err := readContextLine(ctx, client.reader)
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(line) == "" {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(line), &payload); err != nil {
			continue
		}
		if rpcID, ok := payload["id"].(float64); !ok || int64(rpcID) != id {
			continue
		}
		return payload, nil
	}
}

func (client *stdioMCPClient) notify(method string, params map[string]any) error {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
	_, err := client.stdin.Write(append(body, '\n'))
	return err
}

func (client *stdioMCPClient) touch() {
	client.lastUsed.Store(time.Now().UnixNano())
}

func (client *stdioMCPClient) lastUsedAt() time.Time {
	return time.Unix(0, client.lastUsed.Load())
}

func (client *stdioMCPClient) close() {
	_ = client.stdin.Close()
	if client.cmd.Process != nil {
		_ = client.cmd.Process.Kill()
	}
	_ = client.cmd.Wait()
}

func readContextLine(ctx context.Context, reader *bufio.Reader) (string, error) {
	result := make(chan struct {
		line string
		err  error
	}, 1)
	go func() {
		line, err := reader.ReadString('\n')
		result <- struct {
			line string
			err  error
		}{line, err}
	}()
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case item := <-result:
		return strings.TrimSpace(item.line), item.err
	}
}

func stdioServerSignature(server model.MCPServer) string {
	data, _ := json.Marshal(struct {
		Command string
		Args    []string
		Env     map[string]string
		Dir     string
	}{server.Command, server.Args, server.Env, server.WorkingDir})
	return string(data)
}

func stdioServerKey(server model.MCPServer) string {
	if strings.TrimSpace(server.ID) != "" {
		return server.ID
	}
	return stdioServerSignature(server)
}
