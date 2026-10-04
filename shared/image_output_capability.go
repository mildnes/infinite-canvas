package shared

import (
	_ "embed"
	"encoding/json"
	"regexp"
	"strings"
	"time"
)

//go:embed image-output-capability-rules.json
var imageOutputCapabilityRulesJSON []byte

type imageOutputCapabilityRuleSet struct {
	SchemaVersion int                         `json:"schemaVersion"`
	Rules         []imageOutputCapabilityRule `json:"rules"`
}

type imageOutputCapabilityRule struct {
	ID                     string                       `json:"id"`
	Channel                imageOutputCapabilityChannel `json:"channel"`
	ExcludeChannelContains []string                     `json:"excludeChannelContains"`
	Model                  imageOutputCapabilityModel   `json:"model"`
	ExcludeModelRegex      string                       `json:"excludeModelRegex"`
	Formats                []string                     `json:"formats"`
	DefaultFormat          string                       `json:"defaultFormat"`
}

type imageOutputCapabilityChannel struct {
	Protocols       []string `json:"protocols"`
	BaseURLContains []string `json:"baseUrlContains"`
	Combine         string   `json:"combine"`
}

type imageOutputCapabilityModel struct {
	Kind           string `json:"kind"`
	Value          string `json:"value"`
	SnapshotSuffix bool   `json:"snapshotSuffix"`
}

type compiledImageOutputCapabilityRule struct {
	rule              imageOutputCapabilityRule
	modelRegex        *regexp.Regexp
	excludeModelRegex *regexp.Regexp
}

var imageOutputCapabilityRules = loadImageOutputCapabilityRules()

func loadImageOutputCapabilityRules() []compiledImageOutputCapabilityRule {
	var rules imageOutputCapabilityRuleSet
	if err := json.Unmarshal(imageOutputCapabilityRulesJSON, &rules); err != nil {
		panic(err)
	}
	if rules.SchemaVersion != 1 {
		panic("unsupported image output capability rule schema")
	}

	compiled := make([]compiledImageOutputCapabilityRule, 0, len(rules.Rules))
	for _, rule := range rules.Rules {
		item := compiledImageOutputCapabilityRule{rule: rule}
		if rule.Model.Kind == "regex" {
			item.modelRegex = regexp.MustCompile(rule.Model.Value)
		}
		if rule.ExcludeModelRegex != "" {
			item.excludeModelRegex = regexp.MustCompile(rule.ExcludeModelRegex)
		}
		compiled = append(compiled, item)
	}
	return compiled
}

// MatchImageOutputCapabilityRule applies the shared protocol/model rules.
func MatchImageOutputCapabilityRule(protocol, baseURL, channelName, modelName string) ([]string, string, bool) {
	protocol = strings.ToLower(strings.TrimSpace(protocol))
	baseURL = strings.ToLower(strings.TrimSpace(baseURL))
	channelHint := strings.ToLower(strings.TrimSpace(baseURL + " " + channelName))
	modelName = normalizeImageOutputRuleModelName(modelName)
	if modelName == "" {
		return nil, "", false
	}

	for _, item := range imageOutputCapabilityRules {
		rule := item.rule
		if !matchesImageOutputRuleChannel(rule.Channel, protocol, baseURL) || containsImageOutputRuleHint(rule.ExcludeChannelContains, channelHint) {
			continue
		}
		if !matchesImageOutputRuleModel(item, modelName) {
			continue
		}
		return append([]string{}, rule.Formats...), rule.DefaultFormat, true
	}
	return nil, "", false
}

func matchesImageOutputRuleChannel(channel imageOutputCapabilityChannel, protocol, baseURL string) bool {
	protocolConfigured := len(channel.Protocols) > 0
	baseURLConfigured := len(channel.BaseURLContains) > 0
	protocolMatch := containsImageOutputRuleValue(channel.Protocols, protocol)
	baseURLMatch := containsImageOutputRuleHint(channel.BaseURLContains, baseURL)
	if channel.Combine == "any" {
		return (!protocolConfigured && !baseURLConfigured) || protocolMatch || baseURLMatch
	}
	return (!protocolConfigured || protocolMatch) && (!baseURLConfigured || baseURLMatch)
}

func matchesImageOutputRuleModel(item compiledImageOutputCapabilityRule, modelName string) bool {
	matched := false
	switch item.rule.Model.Kind {
	case "prefix":
		matched = strings.HasPrefix(modelName, normalizeImageOutputRuleModelName(item.rule.Model.Value))
	case "exact":
		matched = modelName == normalizeImageOutputRuleModelName(item.rule.Model.Value)
	case "regex":
		matched = item.modelRegex.MatchString(modelName)
		if !matched && item.rule.Model.SnapshotSuffix {
			matched = matchesImageOutputRuleSnapshot(item.modelRegex, modelName)
		}
	}
	return matched && (item.excludeModelRegex == nil || !item.excludeModelRegex.MatchString(modelName))
}

func matchesImageOutputRuleSnapshot(familyPattern *regexp.Regexp, modelName string) bool {
	if len(modelName) < len("-2000-01-01") {
		return false
	}
	dateStart := len(modelName) - len("2000-01-01")
	if modelName[dateStart-1] != '-' {
		return false
	}
	date := modelName[dateStart:]
	if _, err := time.Parse("2006-01-02", date); err != nil {
		return false
	}
	return familyPattern.MatchString(modelName[:dateStart-1])
}

func normalizeImageOutputRuleModelName(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	return strings.NewReplacer("_", "-", ".", "-", "/", "-").Replace(value)
}

func containsImageOutputRuleValue(values []string, value string) bool {
	for _, item := range values {
		if strings.EqualFold(strings.TrimSpace(item), value) {
			return true
		}
	}
	return false
}

func containsImageOutputRuleHint(values []string, hint string) bool {
	for _, item := range values {
		if strings.Contains(hint, strings.ToLower(strings.TrimSpace(item))) {
			return true
		}
	}
	return false
}
