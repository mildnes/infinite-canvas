package service

import (
	"context"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
)

const defaultUserGroupID = "default"

func normalizeUserGroups(groups []model.UserGroupSetting, available []string) []model.UserGroupSetting {
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
		if group.Unrestricted {
			group.Models = []string{}
		}
		result = append(result, group)
	}
	return result
}

// Validate raw input before normalization can hide a deleted default or an empty intersection.
func validateUserGroups(groups, saved []model.UserGroupSetting, available []string) error {
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
		if !group.Unrestricted && len(uniqueModelNames(group.Models)) > 0 && len(filterEnabledModels(group.Models, available)) == 0 {
			return safeMessageError{message: "该分组配置的模型均未开放"}
		}
	}
	if defaults != 1 {
		return safeMessageError{message: "必须保留唯一的默认分组，不可删除或改名 ID"}
	}
	return nil
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
	if !group.Unrestricted && len(filterEnabledModels([]string{modelName}, group.Models)) == 0 {
		return safeMessageError{message: "模型未开放"}
	}
	return nil
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
	available := filterEnabledModels(settings.ModelChannel.AvailableModels, group.Models)
	settings.ModelChannel.AvailableModels = available
	channels := []model.PublicModelChannelInfo{}
	for _, channel := range settings.ModelChannel.Channels {
		channel.Models = filterEnabledModels(channel.Models, available)
		if len(channel.Models) == 0 {
			continue
		}
		channel.ModelMap = filterGroupModelMap(channel.ModelMap, available)
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
