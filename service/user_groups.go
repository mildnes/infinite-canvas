package service

import (
	"context"
	"fmt"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
)

const defaultUserGroupID = "default"

type ModelRename struct {
	ChannelID string `json:"channelId"`
	From      string `json:"from"`
	To        string `json:"to"`
}

type UserGroupScopeChange struct {
	GroupID   string `json:"groupId"`
	ChannelID string `json:"channelId"`
	Model     string `json:"model"`
	Reason    string `json:"reason"`
}

func normalizeUserGroups(groups []model.UserGroupSetting, available []string, channels []model.ModelChannel) []model.UserGroupSetting {
	if len(groups) == 0 {
		return []model.UserGroupSetting{{ID: defaultUserGroupID, Name: "默认用户", IsDefault: true, Unrestricted: true, Models: []string{}}}
	}
	result := make([]model.UserGroupSetting, 0, len(groups))
	for _, group := range groups {
		group.ID = strings.TrimSpace(group.ID)
		if group.ID == "" {
			continue
		}
		group.Name = strings.TrimSpace(group.Name)
		if group.Name == "" {
			group.Name = group.ID
		}
		group.Remark = strings.TrimSpace(group.Remark)
		group.Models = filterEnabledModels(group.Models, available)
		group.Scopes = normalizeUserGroupScopes(group.Scopes, available, channels)
		if group.Unrestricted {
			group.Models = []string{}
			group.Scopes = nil
		}
		result = append(result, group)
	}
	return result
}

// Keep structural checks before normalization can hide a removed default or duplicate ID.
func validateUserGroupStructure(groups, saved []model.UserGroupSetting) error {
	if len(groups) == 0 && len(saved) == 0 {
		return nil
	}
	seen := map[string]bool{}
	defaults := 0
	for _, group := range groups {
		id := strings.TrimSpace(group.ID)
		if id == "" {
			continue
		}
		if seen[id] {
			return safeMessageError{message: "分组 ID 不能重复"}
		}
		seen[id] = true
		if group.IsDefault {
			defaults++
			if id != defaultUserGroupID {
				return safeMessageError{message: "默认分组 ID 必须为 default"}
			}
		} else if id == defaultUserGroupID {
			return safeMessageError{message: "默认分组身份不可修改"}
		}
	}
	if defaults != 1 {
		return safeMessageError{message: "必须保留唯一的默认分组，不可删除或改名 ID"}
	}
	return nil
}

func validateUserGroups(groups, saved []model.UserGroupSetting, available []string, channels []model.ModelChannel) error {
	if err := validateUserGroupStructure(groups, saved); err != nil {
		return err
	}
	for _, group := range groups {
		if group.Unrestricted {
			continue
		}
		hasScopes := false
		for _, scope := range group.Scopes {
			if strings.TrimSpace(scope.ChannelID) == "" || strings.TrimSpace(scope.Model) == "" {
				continue
			}
			hasScopes = true
			scope = trimmedUserGroupScope(scope)
			if userGroupScopeInvalidReason(scope, available, channels) != "" {
				return invalidUserGroupScopeError(group, scope, channels)
			}
		}
		if (len(uniqueModelNames(group.Models)) > 0 || hasScopes) && len(filterEnabledModels(group.Models, available)) == 0 && len(normalizeUserGroupScopes(group.Scopes, available, channels)) == 0 {
			return safeMessageError{message: "该分组配置的模型均未开放"}
		}
	}
	return nil
}

func trimmedUserGroupScope(scope model.UserGroupModelScope) model.UserGroupModelScope {
	return model.UserGroupModelScope{ChannelID: strings.TrimSpace(scope.ChannelID), Model: strings.TrimSpace(scope.Model)}
}

func userGroupScopeInvalidReason(scope model.UserGroupModelScope, available []string, channels []model.ModelChannel) string {
	for _, channel := range channels {
		if channel.ID != scope.ChannelID {
			continue
		}
		if len(filterEnabledModels([]string{scope.Model}, channel.Models)) == 0 {
			return "model_removed"
		}
		if len(filterEnabledModels([]string{scope.Model}, available)) == 0 {
			return "unresolvable"
		}
		return ""
	}
	return "channel_removed"
}

func invalidUserGroupScopeError(group model.UserGroupSetting, scope model.UserGroupModelScope, channels []model.ModelChannel) error {
	for _, channel := range channels {
		if channel.ID == scope.ChannelID {
			return safeMessageError{message: fmt.Sprintf("%s 分组引用了不存在或未开放的模型「%s」（渠道 %s / %s）", firstNonEmpty(group.Name, group.ID), scope.Model, firstNonEmpty(channel.Name, channel.ID), channel.ID)}
		}
	}
	return safeMessageError{message: fmt.Sprintf("%s 分组引用了不存在的渠道「%s」（模型「%s」）", firstNonEmpty(group.Name, group.ID), scope.ChannelID, scope.Model)}
}

func userGroupModelRenames(previous, channels []model.ModelChannel, explicit []ModelRename) (map[model.UserGroupModelScope]string, error) {
	result := map[model.UserGroupModelScope]string{}
	oldChannels, newChannels := map[string]model.ModelChannel{}, map[string]model.ModelChannel{}
	for _, channel := range previous {
		oldChannels[channel.ID] = channel
	}
	for _, channel := range channels {
		newChannels[channel.ID] = channel
	}
	for _, rename := range explicit {
		rename.ChannelID, rename.From, rename.To = strings.TrimSpace(rename.ChannelID), strings.TrimSpace(rename.From), strings.TrimSpace(rename.To)
		key := model.UserGroupModelScope{ChannelID: rename.ChannelID, Model: rename.From}
		old, next := oldChannels[rename.ChannelID], newChannels[rename.ChannelID]
		if rename.From == "" || rename.To == "" || rename.From == rename.To ||
			len(filterEnabledModels([]string{rename.From}, old.Models)) == 0 ||
			len(filterEnabledModels([]string{rename.From}, next.Models)) != 0 ||
			len(filterEnabledModels([]string{rename.To}, next.Models)) == 0 ||
			(result[key] != "" && result[key] != rename.To) {
			return nil, safeMessageError{message: fmt.Sprintf("渠道 %s 的模型改名无效：「%s」→「%s」", rename.ChannelID, rename.From, rename.To)}
		}
		result[key] = rename.To
	}
	for _, old := range previous {
		next, exists := newChannels[old.ID]
		if !exists {
			continue
		}
		for _, from := range old.Models {
			key := model.UserGroupModelScope{ChannelID: old.ID, Model: from}
			upstream := strings.TrimSpace(old.ModelMap[from])
			if result[key] != "" || upstream == "" || len(filterEnabledModels([]string{from}, next.Models)) > 0 {
				continue
			}
			candidates := []string{}
			for _, to := range next.Models {
				if strings.TrimSpace(next.ModelMap[to]) == upstream && len(filterEnabledModels([]string{to}, old.Models)) == 0 {
					candidates = append(candidates, to)
				}
			}
			if len(candidates) == 1 {
				result[key] = candidates[0]
			}
		}
	}
	return result, nil
}

func reconcileUserGroupScopes(groups, saved []model.UserGroupSetting, previous, channels []model.ModelChannel, available []string, renames []ModelRename) ([]model.UserGroupSetting, []UserGroupScopeChange, error) {
	mapping, err := userGroupModelRenames(previous, channels, renames)
	if err != nil {
		return nil, nil, err
	}
	savedGroups := map[string]model.UserGroupSetting{}
	for _, group := range saved {
		savedGroups[strings.TrimSpace(group.ID)] = group
	}
	result := make([]model.UserGroupSetting, 0, len(groups))
	cleaned := []UserGroupScopeChange{}
	seenChanges := map[UserGroupScopeChange]bool{}
	record := func(groupID string, scope model.UserGroupModelScope, reason string) {
		change := UserGroupScopeChange{GroupID: groupID, ChannelID: scope.ChannelID, Model: scope.Model, Reason: reason}
		if !seenChanges[change] {
			cleaned = append(cleaned, change)
			seenChanges[change] = true
		}
	}
	for _, group := range groups {
		group.ID = strings.TrimSpace(group.ID)
		if group.Unrestricted {
			group.Scopes = nil
			result = append(result, group)
			continue
		}
		old := savedGroups[group.ID]
		inherited := map[model.UserGroupModelScope]bool{}
		if !old.Unrestricted {
			for _, scope := range old.Scopes {
				inherited[trimmedUserGroupScope(scope)] = true
			}
		}
		scopes := []model.UserGroupModelScope{}
		submitted := map[model.UserGroupModelScope]bool{}
		for _, scope := range group.Scopes {
			scope = trimmedUserGroupScope(scope)
			if scope.ChannelID == "" || scope.Model == "" {
				continue
			}
			submitted[scope] = true
			original := scope
			if to := mapping[scope]; inherited[original] && to != "" {
				scope.Model = to
			}
			if reason := userGroupScopeInvalidReason(scope, available, channels); reason != "" {
				if !inherited[original] {
					return nil, nil, invalidUserGroupScopeError(group, scope, channels)
				}
				record(group.ID, original, reason)
				continue
			}
			if scope.Model != original.Model {
				record(group.ID, original, "model_renamed")
			}
			scopes = append(scopes, scope)
		}
		// Admin reads already normalize legacy data; still report what this save removes from disk.
		for _, scope := range old.Scopes {
			scope = trimmedUserGroupScope(scope)
			if !old.Unrestricted && !submitted[scope] {
				if reason := userGroupScopeInvalidReason(scope, available, channels); reason != "" {
					record(group.ID, scope, reason)
				}
			}
		}
		group.Scopes = scopes
		result = append(result, group)
	}
	return result, cleaned, nil
}

func normalizeUserGroupScopes(scopes []model.UserGroupModelScope, available []string, channels []model.ModelChannel) []model.UserGroupModelScope {
	var result []model.UserGroupModelScope
	seen := map[model.UserGroupModelScope]bool{}
	for _, scope := range scopes {
		scope.ChannelID = strings.TrimSpace(scope.ChannelID)
		scope.Model = strings.TrimSpace(scope.Model)
		if scope.ChannelID == "" || scope.Model == "" || seen[scope] || userGroupScopeInvalidReason(scope, available, channels) != "" {
			continue
		}
		seen[scope] = true
		result = append(result, scope)
	}
	return result
}

// The sole group permission predicate; legacy names deliberately allow every channel.
func userGroupAllowsModel(group model.UserGroupSetting, channelID, modelName string) bool {
	if group.Unrestricted || len(filterEnabledModels([]string{modelName}, group.Models)) > 0 {
		return true
	}
	for _, scope := range group.Scopes {
		if scope.ChannelID == channelID && scope.Model == modelName {
			return true
		}
	}
	return false
}

func validateUserGroupID(id string, groups []model.UserGroupSetting) error {
	if strings.TrimSpace(id) == "" {
		return nil
	}
	for _, group := range groups {
		if group.ID == strings.TrimSpace(id) {
			return nil
		}
	}
	return safeMessageError{message: "用户分组不存在"}
}

func groupForUser(groups []model.UserGroupSetting, user model.AuthUser) model.UserGroupSetting {
	var fallback model.UserGroupSetting
	for _, group := range groups {
		if group.ID == defaultUserGroupID && group.IsDefault {
			fallback = group
		}
		if user.GroupID != "" && group.ID == user.GroupID {
			return group
		}
	}
	// Malformed non-legacy configuration fails closed rather than granting all models.
	return fallback
}

func checkUserGroupModelAccess(ctx context.Context, settings model.Settings, modelName string) error {
	global := settings.Public.ModelChannel.AvailableModels
	if len(global) > 0 && len(filterEnabledModels([]string{modelName}, global)) == 0 {
		return safeMessageError{message: "模型未开放"}
	}
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" || user.Role == model.UserRoleGuest {
		return nil
	}
	group := groupForUser(settings.Public.ModelChannel.UserGroups, user)
	if userGroupAllowsModel(group, "", modelName) {
		return nil
	}
	for _, channel := range settings.Private.Channels {
		if userGroupAllowsModel(group, channel.ID, modelName) {
			return nil
		}
	}
	return safeMessageError{message: "模型未开放"}
}

func PublicSettingsForUser(user model.AuthUser) (model.PublicSetting, error) {
	settings, err := PublicSettings()
	if err != nil {
		return settings, err
	}
	settings = filterPublicSettingsForUser(settings, user)
	// Group policy is admin configuration; public clients only need their model projection.
	settings.ModelChannel.UserGroups = nil
	return settings, nil
}

func filterPublicSettingsForUser(settings model.PublicSetting, user model.AuthUser) model.PublicSetting {
	if user.ID == "" || user.Role == model.UserRoleGuest {
		return settings
	}
	group := groupForUser(settings.ModelChannel.UserGroups, user)
	if group.Unrestricted {
		return settings
	}
	visibleModels := []string{}
	channels := []model.PublicModelChannelInfo{}
	for _, channel := range settings.ModelChannel.Channels {
		models := []string{}
		for _, name := range filterEnabledModels(channel.Models, settings.ModelChannel.AvailableModels) {
			if userGroupAllowsModel(group, channel.ID, name) {
				models = append(models, name)
			}
		}
		channel.Models = models
		if len(channel.Models) == 0 {
			continue
		}
		visibleModels = append(visibleModels, models...)
		channel.ModelMap = filterGroupModelMap(channel.ModelMap, models)
		capabilities := map[string][]model.ModelCapability{}
		for _, name := range channel.Models {
			if values, ok := channel.ModelCapabilities[name]; ok {
				capabilities[name] = values
			}
		}
		channel.ModelCapabilities = capabilities
		channel.ImageOutputCapabilities = normalizeImageOutputCapabilities(channel.ImageOutputCapabilities, channel.Models)
		quality := map[string]model.ImageQualityCapability{}
		for _, name := range channel.Models {
			if value, ok := channel.ImageQualityCapabilities[name]; ok {
				quality[name] = value
			}
		}
		channel.ImageQualityCapabilities = quality
		channels = append(channels, channel)
	}
	settings.ModelChannel.Channels = channels
	available := filterEnabledModels(settings.ModelChannel.AvailableModels, uniqueModelNames(visibleModels))
	settings.ModelChannel.AvailableModels = available
	// Costs are part of the public projection too: a restricted group must not
	// learn the names or prices of models outside its whitelist.
	settings.ModelChannel.ModelCosts = filterGroupModelCosts(settings.ModelChannel.ModelCosts, channels)
	private := make([]model.ModelChannel, 0, len(channels))
	for _, channel := range channels {
		private = append(private, model.ModelChannel{Models: channel.Models, ModelMap: channel.ModelMap, ModelCapabilities: channel.ModelCapabilities})
	}
	setting := &settings.ModelChannel
	setting.DefaultModel = repairGroupDefaultModelForCapability(setting.DefaultModel, available, private, model.ModelCapabilityText, isTextModelName)
	setting.DefaultTextModel = repairGroupDefaultModelForCapability(setting.DefaultTextModel, available, private, model.ModelCapabilityText, isTextModelName)
	setting.DefaultImageModel = repairGroupDefaultModelForCapability(setting.DefaultImageModel, available, private, model.ModelCapabilityImage, isImageModelName)
	setting.DefaultVideoModel = repairGroupDefaultModelForCapability(setting.DefaultVideoModel, available, private, model.ModelCapabilityVideo, isVideoModelName)
	return settings // Never re-enter PublicSettings/publicChannelInfos: [] means deny all here.
}

func filterGroupModelCosts(costs []model.ModelCost, channels []model.PublicModelChannelInfo) []model.ModelCost {
	result := make([]model.ModelCost, 0, len(costs))
	for _, cost := range costs {
		for _, channel := range channels {
			if cost.ChannelID == channel.ID && len(filterEnabledModels([]string{cost.Model}, channel.Models)) > 0 {
				result = append(result, cost)
				break
			}
		}
	}
	return result
}

func filterGroupModelMap(mapping map[string]string, models []string) map[string]string {
	result := map[string]string{}
	for _, name := range models {
		if value, ok := mapping[name]; ok {
			result[name] = value
		}
	}
	return result
}

func repairGroupDefaultModelForCapability(current string, models []string, channels []model.ModelChannel, capability model.ModelCapability, fallback func(string) bool) string {
	for _, name := range append([]string{current}, models...) {
		if len(filterEnabledModels([]string{name}, models)) > 0 && modelMatchesCapability(channels, name, capability, fallback) {
			return name
		}
	}
	return ""
}
