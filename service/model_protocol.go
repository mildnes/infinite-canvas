package service

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
)

const (
	ModelChannelProtocolOpenAI   = "openai"
	ModelChannelProtocolXAI      = "xai"
	ModelChannelProtocolGrok2API = "grok2api"
	ModelChannelProtocolMetaso   = ModelChannelProtocolMiniMax
	ModelChannelProtocolAPIMart  = "apimart"
	ModelChannelProtocolKIE      = "kie"
	ModelChannelProtocolArk      = "ark"
)

type modelProtocolAdapter struct {
	buildURL  func(model.ModelChannel, string) string
	setAuth   func(*http.Request, model.ModelChannel)
	models    func(model.ModelChannel) ([]string, error)
	testModel func(model.ModelChannel, string) (string, error)
}

type modelProtocolRule struct {
	id      string
	matches func(model.ModelChannel, string) bool
}

var modelProtocolRegistry map[string]modelProtocolAdapter

var modelProtocolIDs = []string{
	ModelChannelProtocolOpenAI,
	ModelChannelProtocolGemini,
	ModelChannelProtocolGrok2API,
	ModelChannelProtocolXAI,
	ModelChannelProtocolMetaso,
	ModelChannelProtocolAPIMart,
	ModelChannelProtocolKIE,
	ModelChannelProtocolMiMo,
	ModelChannelProtocolArk,
}

func init() {
	compatible := modelProtocolAdapter{
		buildURL: buildOpenAIModelChannelURL,
		setAuth: func(request *http.Request, channel model.ModelChannel) {
			request.Header.Set("Authorization", "Bearer "+channel.APIKey)
		},
		models:    fetchOpenAIAdminChannelModels,
		testModel: testOpenAIChannelModel,
	}
	modelProtocolRegistry = make(map[string]modelProtocolAdapter, len(modelProtocolIDs)+2)
	for _, id := range modelProtocolIDs {
		modelProtocolRegistry[id] = compatible
	}

	gemini := compatible
	gemini.buildURL = BuildGeminiChannelURL
	gemini.setAuth = func(request *http.Request, channel model.ModelChannel) {
		request.Header.Set("x-goog-api-key", channel.APIKey)
	}
	gemini.models = fetchGeminiAdminChannelModels
	gemini.testModel = testGeminiChannelModel
	modelProtocolRegistry[ModelChannelProtocolGemini] = gemini

	metaso := compatible
	metaso.buildURL = func(channel model.ModelChannel, path string) string {
		return normalizeModelChannelBaseURL(channel.BaseURL) + path
	}
	metaso.models = func(model.ModelChannel) ([]string, error) {
		result := append([]string(nil), MiniMaxModels()...)
		sort.Strings(result)
		return result, nil
	}
	metaso.testModel = func(model.ModelChannel, string) (string, error) {
		return "MiniMax-H3 是异步视频模型，请在视频创作台测试生成。", nil
	}
	modelProtocolRegistry[ModelChannelProtocolMetaso] = metaso

	mimo := compatible
	mimo.models = func(model.ModelChannel) ([]string, error) {
		result := MiMoModels()
		sort.Strings(result)
		return result, nil
	}
	mimo.testModel = testMiMoTTSChannelModel
	modelProtocolRegistry[ModelChannelProtocolMiMo] = mimo

	kie := compatible
	kie.models = func(model.ModelChannel) ([]string, error) {
		result := kieMarketModels()
		sort.Strings(result)
		return result, nil
	}
	modelProtocolRegistry[ModelChannelProtocolKIE] = kie

	// Grok2API and xAI deliberately share one adapter. Their media request
	// translation lives in handler/model_protocol.go, while model discovery
	// keeps the existing upstream-plus-built-in fallback behavior.
	grok := compatible
	grok.models = fetchGrok2APIChannelModels
	modelProtocolRegistry[ModelChannelProtocolGrok2API] = grok
	modelProtocolRegistry[ModelChannelProtocolXAI] = grok

	ark := compatible
	ark.testModel = testArkSeedanceChannelModel
	modelProtocolRegistry[ModelChannelProtocolArk] = ark
	glm := compatible
	glm.testModel = testGLMTTSChannelModel
	modelProtocolRegistry["model:glm-tts"] = glm
}

// Discovery, configuration tests and generation tests intentionally use
// separate rule lists so their existing precedence remains explicit.
var modelDiscoveryRules = []modelProtocolRule{
	{ModelChannelProtocolGemini, func(channel model.ModelChannel, _ string) bool { return IsGeminiChannel(channel) }},
	{ModelChannelProtocolMetaso, func(channel model.ModelChannel, _ string) bool { return IsMiniMaxChannel(channel) }},
	{ModelChannelProtocolMiMo, func(channel model.ModelChannel, _ string) bool { return IsMiMoChannel(channel) }},
	{ModelChannelProtocolArk, func(channel model.ModelChannel, _ string) bool { return IsArkChannel(channel) }},
	{ModelChannelProtocolKIE, func(channel model.ModelChannel, _ string) bool { return isKIEAdminChannel(channel) }},
	{ModelChannelProtocolGrok2API, func(channel model.ModelChannel, _ string) bool { return isGrok2APIProtocolChannel(channel) }},
}

var modelConfigTestRules = []modelProtocolRule{
	{ModelChannelProtocolMetaso, func(channel model.ModelChannel, _ string) bool { return IsMiniMaxChannel(channel) }},
	{ModelChannelProtocolArk, func(channel model.ModelChannel, _ string) bool { return IsArkChannel(channel) }},
}

var modelGenerationTestRules = []modelProtocolRule{
	{"model:glm-tts", func(_ model.ModelChannel, modelName string) bool {
		return strings.EqualFold(strings.TrimSpace(modelName), "glm-tts")
	}},
	{ModelChannelProtocolMiMo, func(_ model.ModelChannel, modelName string) bool { return IsMiMoTTSModelName(modelName) }},
	{ModelChannelProtocolGemini, func(channel model.ModelChannel, _ string) bool { return IsGeminiChannel(channel) }},
}

func isGrok2APIProtocolChannel(channel model.ModelChannel) bool {
	protocol := strings.ToLower(strings.TrimSpace(channel.Protocol))
	baseURL := strings.ToLower(strings.TrimSpace(channel.BaseURL))
	if protocol == ModelChannelProtocolKIE || protocol == ModelChannelProtocolAPIMart || protocol == ModelChannelProtocolMetaso || protocol == ModelChannelProtocolArk {
		return false
	}
	return protocol == ModelChannelProtocolGrok2API || protocol == ModelChannelProtocolXAI ||
		strings.Contains(baseURL, "grok2api") || strings.Contains(baseURL, "api.x.ai") || strings.Contains(baseURL, "x.ai/")
}

func fetchOpenAIAdminChannelModels(channel model.ModelChannel) ([]string, error) {
	result, err := fetchOpenAICompatibleModels(channel)
	if err != nil {
		return nil, err
	}
	sort.Strings(result)
	return result, nil
}

func testOpenAIChannelModel(channel model.ModelChannel, modelName string) (string, error) {
	if strings.TrimSpace(modelName) == "" {
		return "", errors.New("缺少模型名称")
	}
	body, _ := json.Marshal(map[string]any{
		"model": modelName,
		"messages": []map[string]string{{
			"role":    "user",
			"content": "hi",
		}},
	})
	request, err := http.NewRequest(http.MethodPost, buildOpenAIModelChannelURL(channel, "/chat/completions"), strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := adminModelHTTPClient.Do(request)
	if err != nil {
		return "", safeMessageError{message: "测试失败：上游接口无响应或网络不可达"}
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode >= http.StatusBadRequest {
		return "", readAdminChannelError(responseBody, response.StatusCode, "测试失败")
	}
	var payload struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	_ = json.Unmarshal(responseBody, &payload)
	if len(payload.Choices) > 0 && strings.TrimSpace(payload.Choices[0].Message.Content) != "" {
		return payload.Choices[0].Message.Content, nil
	}
	return "ok", nil
}

func modelProtocolForChannel(channel model.ModelChannel) modelProtocolAdapter {
	protocol := strings.ToLower(strings.TrimSpace(channel.Protocol))
	// Explicit provider protocols must win over URL inference. OpenAI is the
	// compatibility value used by older Grok/xAI channels, so infer those
	// gateways before returning the generic OpenAI adapter.
	if protocol != "" && protocol != ModelChannelProtocolOpenAI {
		if adapter, ok := modelProtocolRegistry[protocol]; ok {
			return adapter
		}
	}
	if isGrok2APIProtocolChannel(channel) {
		return modelProtocolRegistry[ModelChannelProtocolGrok2API]
	}
	if adapter, ok := modelProtocolRegistry[protocol]; ok {
		return adapter
	}
	return modelProtocolRegistry[ModelChannelProtocolOpenAI]
}

func IsArkChannel(channel model.ModelChannel) bool {
	return strings.EqualFold(strings.TrimSpace(channel.Protocol), ModelChannelProtocolArk)
}

func matchModelProtocol(rules []modelProtocolRule, channel model.ModelChannel, modelName string) (modelProtocolAdapter, bool) {
	for _, rule := range rules {
		if rule.matches(channel, modelName) {
			return modelProtocolRegistry[rule.id], true
		}
	}
	return modelProtocolRegistry[ModelChannelProtocolOpenAI], false
}
