package service

import (
	"crypto/sha256"
	"fmt"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const agentSkillMigrationVersion = "v0.6.0"

// MigrateLegacyAgentSkills moves private.agent.skills into the system Skill tables once.
func MigrateLegacyAgentSkills() error {
	settings, err := repository.GetSettings()
	if err != nil {
		return err
	}
	current := now()
	items := make([]model.AgentSkill, 0, len(settings.Private.Agent.Skills))
	for index, legacy := range settings.Private.Agent.Skills {
		items = append(items, model.AgentSkill{
			ID:          legacyAgentSkillID(legacy, index),
			Source:      model.AgentSkillSourceSystem,
			Name:        strings.TrimSpace(legacy.Name),
			Description: strings.TrimSpace(legacy.Description),
			Content:     strings.TrimSpace(legacy.Prompt),
			Enabled:     legacy.Enabled,
			Sort:        index,
			CreatedAt:   firstNonEmpty(strings.TrimSpace(legacy.InstalledAt), current),
			UpdatedAt:   current,
		})
	}
	_, err = repository.MigrateLegacyAgentSkills(items, current, agentSkillMigrationVersion)
	return err
}

func legacyAgentSkillID(item model.LegacyAgentSkill, index int) string {
	identity := strings.Join([]string{item.ID, item.Repository, item.Ref, item.Path, item.Name, fmt.Sprint(index)}, "\x00")
	digest := sha256.Sum256([]byte(identity))
	return fmt.Sprintf("agent-skill-legacy-%x", digest[:8])
}
