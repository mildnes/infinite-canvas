package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

type RemoteAgentSkillRequest struct {
	Repository string `json:"repository"`
	Ref        string `json:"ref"`
	Path       string `json:"path"`
	Name       string `json:"name"`
}

func InstallRemoteAgentSkill(ctx context.Context, request RemoteAgentSkillRequest) (model.AgentSkill, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.Role != model.UserRoleAdmin {
		return model.AgentSkill{}, errors.New("未登录或权限不足")
	}
	rawURL, repositoryURL, ref, skillPath, err := normalizeGitHubSkillSource(request)
	if err != nil {
		return model.AgentSkill{}, err
	}
	document, err := fetchRemoteSkillDocument(ctx, rawURL)
	if err != nil {
		return model.AgentSkill{}, err
	}
	frontMatter, prompt := splitSkillFrontMatter(document)
	if strings.TrimSpace(prompt) == "" {
		return model.AgentSkill{}, errors.New("SKILL.md 没有可用的技能正文")
	}
	name := strings.TrimSpace(request.Name)
	if name == "" {
		name = firstSkillFrontMatter(frontMatter, "name")
	}
	if name == "" {
		name = path.Base(path.Dir(skillPath))
		if name == "." || name == "/" || name == "" {
			name = strings.TrimSuffix(path.Base(skillPath), path.Ext(skillPath))
		}
	}
	description := firstSkillFrontMatter(frontMatter, "description")
	settings, err := repository.GetSettings()
	if err != nil {
		return model.AgentSkill{}, err
	}
	settings = normalizeSettings(settings)
	skill := model.AgentSkill{
		ID:          stableAgentID("github:"+repositoryURL+":"+ref+":"+skillPath, len(settings.Private.Agent.Skills)),
		Name:        name,
		Description: description,
		Prompt:      prompt,
		Enabled:     true,
		Source:      "github",
		Repository:  repositoryURL,
		Ref:         ref,
		Path:        skillPath,
		InstalledAt: time.Now().Format(time.RFC3339),
	}
	replaced := false
	for i := range settings.Private.Agent.Skills {
		existing := &settings.Private.Agent.Skills[i]
		if existing.Repository == skill.Repository && existing.Ref == skill.Ref && existing.Path == skill.Path {
			skill.ID = existing.ID
			skill.Enabled = existing.Enabled
			settings.Private.Agent.Skills[i] = skill
			replaced = true
			break
		}
	}
	if !replaced {
		settings.Private.Agent.Skills = append(settings.Private.Agent.Skills, skill)
	}
	if _, err := SaveSettings(settings); err != nil {
		return model.AgentSkill{}, err
	}
	return skill, nil
}

func normalizeGitHubSkillSource(request RemoteAgentSkillRequest) (string, string, string, string, error) {
	source := strings.TrimSpace(request.Repository)
	if source == "" {
		return "", "", "", "", errors.New("请输入 GitHub 仓库或 SKILL.md 地址")
	}
	if !strings.Contains(source, "://") {
		source = "https://github.com/" + strings.TrimPrefix(source, "/")
	}
	parsed, err := url.Parse(source)
	if err != nil || parsed.Scheme != "https" {
		return "", "", "", "", errors.New("GitHub 地址必须使用 https")
	}
	ref := strings.TrimSpace(request.Ref)
	skillPath := strings.Trim(strings.TrimSpace(request.Path), "/")
	repositoryURL := ""
	if parsed.Host == "raw.githubusercontent.com" {
		segments := nonEmptyPathSegments(parsed.Path)
		if len(segments) < 4 {
			return "", "", "", "", errors.New("Raw GitHub 地址格式不正确")
		}
		repositoryURL = "https://github.com/" + segments[0] + "/" + segments[1]
		if ref == "" {
			ref = segments[2]
		}
		if skillPath == "" {
			skillPath = strings.Join(segments[3:], "/")
		}
	} else if parsed.Host == "github.com" {
		segments := nonEmptyPathSegments(parsed.Path)
		if len(segments) < 2 {
			return "", "", "", "", errors.New("GitHub 仓库地址格式不正确")
		}
		repositoryURL = "https://github.com/" + segments[0] + "/" + segments[1]
		if len(segments) >= 4 && (segments[2] == "blob" || segments[2] == "tree") {
			if ref == "" {
				ref = segments[3]
			}
			if skillPath == "" && len(segments) > 4 {
				skillPath = strings.Join(segments[4:], "/")
			}
		}
	} else {
		return "", "", "", "", errors.New("只支持 github.com 或 raw.githubusercontent.com 地址")
	}
	if ref == "" {
		ref = "main"
	}
	if skillPath == "" {
		skillPath = "SKILL.md"
	}
	if strings.Contains(skillPath, "..") {
		return "", "", "", "", errors.New("Skill 路径不合法")
	}
	return "https://raw.githubusercontent.com/" + strings.TrimPrefix(strings.TrimPrefix(repositoryURL, "https://github.com/"), "/") + "/" + url.PathEscape(ref) + "/" + strings.ReplaceAll(skillPath, " ", "%20"), repositoryURL, ref, skillPath, nil
}

func fetchRemoteSkillDocument(ctx context.Context, rawURL string) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("User-Agent", "infinite-canvas-skill-installer")
	response, err := (&http.Client{Timeout: 30 * time.Second}).Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound && strings.Contains(rawURL, "/main/") {
		fallback := strings.Replace(rawURL, "/main/", "/master/", 1)
		return fetchRemoteSkillDocument(ctx, fallback)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("远程 SKILL.md 拉取失败：HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 512*1024+1))
	if err != nil {
		return "", err
	}
	if len(body) > 512*1024 {
		return "", errors.New("SKILL.md 超过 512KB，拒绝安装")
	}
	return string(body), nil
}

func splitSkillFrontMatter(document string) (map[string]string, string) {
	document = strings.TrimPrefix(document, "\uFEFF")
	lines := strings.Split(strings.ReplaceAll(document, "\r\n", "\n"), "\n")
	if len(lines) < 3 || strings.TrimSpace(lines[0]) != "---" {
		return map[string]string{}, strings.TrimSpace(document)
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			end = i
			break
		}
	}
	if end < 0 {
		return map[string]string{}, strings.TrimSpace(document)
	}
	frontMatter := map[string]string{}
	for _, line := range lines[1:end] {
		key, value, ok := strings.Cut(line, ":")
		if ok {
			frontMatter[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(value), "\"'")
		}
	}
	return frontMatter, strings.TrimSpace(strings.Join(lines[end+1:], "\n"))
}

func firstSkillFrontMatter(frontMatter map[string]string, key string) string {
	return strings.TrimSpace(frontMatter[key])
}

func nonEmptyPathSegments(value string) []string {
	return strings.FieldsFunc(strings.Trim(value, "/"), func(r rune) bool { return r == '/' })
}
