package service

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

var agentSkillHTTPClient = &http.Client{Timeout: 30 * time.Second}

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
	current := now()
	id := remoteAgentSkillID(repositoryURL, ref, skillPath)
	files := fetchRemoteAgentSkillAttachments(ctx, repositoryURL, ref, skillPath)
	skill := model.AgentSkill{
		ID:          id,
		Source:      model.AgentSkillSourceSystem,
		Name:        name,
		Description: description,
		Content:     strings.TrimSpace(document),
		Enabled:     true,
		CreatedAt:   current,
		UpdatedAt:   current,
		Files:       files,
	}
	return SaveRemoteSystemAgentSkill(skill)
}

func SaveRemoteSystemAgentSkill(input model.AgentSkill) (model.AgentSkill, error) {
	if strings.TrimSpace(input.Name) == "" || strings.TrimSpace(input.Content) == "" {
		return model.AgentSkill{}, errors.New("远程 Skill 名称或内容为空")
	}
	if utf8.RuneCountInString(input.Content) > maxAgentSkillContentLength {
		return model.AgentSkill{}, errors.New("Skill 内容不能超过 20000 字")
	}
	current := now()
	files, err := normalizeAgentSkillFiles(input.ID, input.Files, current)
	if err != nil {
		return model.AgentSkill{}, err
	}
	existing, found, err := repository.GetAgentSkill(input.ID)
	if err != nil {
		return model.AgentSkill{}, err
	}
	if found {
		if existing.Source != model.AgentSkillSourceSystem {
			return model.AgentSkill{}, errors.New("Skill ID 已被占用")
		}
		input.Enabled = existing.Enabled
		input.CreatedAt = existing.CreatedAt
	}
	input.Source = model.AgentSkillSourceSystem
	input.UpdatedAt = current
	return repository.SaveAgentSkillPackage(input, files)
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
	response, err := agentSkillHTTPClient.Do(request)
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

type githubContentItem struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Type        string `json:"type"`
	DownloadURL string `json:"download_url"`
}

func fetchRemoteAgentSkillAttachments(ctx context.Context, repositoryURL string, ref string, skillPath string) []model.AgentSkillFile {
	repositoryPath := strings.TrimPrefix(repositoryURL, "https://github.com/")
	directory := path.Dir(skillPath)
	apiURL := "https://api.github.com/repos/" + repositoryPath + "/contents"
	if directory != "." {
		apiURL += "/" + strings.ReplaceAll(directory, " ", "%20")
	}
	apiURL += "?ref=" + url.QueryEscape(ref)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return nil
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "infinite-canvas-skill-installer")
	response, err := agentSkillHTTPClient.Do(request)
	if err != nil {
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil
	}
	var entries []githubContentItem
	if err := json.NewDecoder(io.LimitReader(response.Body, 1024*1024)).Decode(&entries); err != nil {
		return nil
	}
	files := make([]model.AgentSkillFile, 0, len(entries))
	for _, entry := range entries {
		ext := strings.ToLower(path.Ext(entry.Name))
		if entry.Type != "file" || entry.Path == skillPath || (ext != ".md" && ext != ".markdown" && ext != ".txt") {
			continue
		}
		content, err := fetchRemoteTextFile(ctx, entry.DownloadURL)
		if err != nil {
			continue
		}
		files = append(files, model.AgentSkillFile{Path: entry.Name, Kind: model.AgentSkillFileKindFile, Content: content, Sort: len(files)})
	}
	return files
}

func fetchRemoteTextFile(ctx context.Context, rawURL string) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("User-Agent", "infinite-canvas-skill-installer")
	response, err := agentSkillHTTPClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 512*1024+1))
	if err != nil {
		return "", err
	}
	if len(body) > 512*1024 {
		return "", errors.New("附件超过 512KB")
	}
	return string(body), nil
}

func remoteAgentSkillID(repositoryURL string, ref string, skillPath string) string {
	digest := sha256.Sum256([]byte(repositoryURL + "\x00" + ref + "\x00" + skillPath))
	return fmt.Sprintf("agent-skill-github-%x", digest[:8])
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
