use std::collections::HashMap;

use zed_extension_api::settings::LspSettings;
use zed_extension_api::{self as zed, EnvVars, LanguageServerId, Result, Worktree};

const LANGUAGE_SERVER_ID: &str = "shuck";
const SHUCK_BINARY: &str = "shuck";
const DEFAULT_ARGUMENTS: &[&str] = &["server"];

struct ShuckExtension;

impl zed::Extension for ShuckExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<zed::Command> {
        if language_server_id.as_ref() != LANGUAGE_SERVER_ID {
            return Err(format!(
                "Shuck does not provide language server '{language_server_id}'"
            ));
        }

        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)?;
        let binary = settings.binary;
        let command = resolve_command_path(binary.as_ref(), worktree)?;
        let args = resolve_arguments(binary.as_ref());
        let env = resolve_environment(binary.as_ref());

        Ok(zed::Command { command, args, env })
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(
            LspSettings::for_worktree(language_server_id.as_ref(), worktree)?
                .initialization_options,
        )
    }

    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(LspSettings::for_worktree(language_server_id.as_ref(), worktree)?.settings)
    }
}

fn resolve_command_path(
    binary: Option<&zed::settings::CommandSettings>,
    worktree: &Worktree,
) -> Result<String> {
    if let Some(path) = configured_command_path(binary)? {
        return Ok(path);
    }

    worktree.which(SHUCK_BINARY).ok_or_else(|| {
        "Shuck executable not found. Install `shuck` and make it available on the Zed shell PATH, or set lsp.shuck.binary.path in settings.json.".to_string()
    })
}

fn configured_command_path(
    binary: Option<&zed::settings::CommandSettings>,
) -> Result<Option<String>> {
    let Some(path) = binary.and_then(|settings| settings.path.as_deref()) else {
        return Ok(None);
    };

    if path.trim().is_empty() {
        return Err("Shuck binary.path must not be empty".to_string());
    }

    Ok(Some(path.to_string()))
}

fn resolve_arguments(binary: Option<&zed::settings::CommandSettings>) -> Vec<String> {
    binary
        .and_then(|settings| settings.arguments.clone())
        .unwrap_or_else(|| {
            DEFAULT_ARGUMENTS
                .iter()
                .map(|argument| (*argument).to_string())
                .collect()
        })
}

fn resolve_environment(binary: Option<&zed::settings::CommandSettings>) -> EnvVars {
    binary
        .and_then(|settings| settings.env.clone())
        .map(hash_map_into_env)
        .unwrap_or_default()
}

fn hash_map_into_env(values: HashMap<String, String>) -> EnvVars {
    values.into_iter().collect()
}

zed::register_extension!(ShuckExtension);

#[cfg(test)]
mod tests {
    use super::{configured_command_path, hash_map_into_env, resolve_arguments, DEFAULT_ARGUMENTS};
    use std::collections::HashMap;

    #[test]
    fn defaults_to_server_subcommand() {
        assert_eq!(
            resolve_arguments(None),
            DEFAULT_ARGUMENTS
                .iter()
                .map(|argument| (*argument).to_string())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn configured_arguments_replace_defaults() {
        let settings = super::zed::settings::CommandSettings {
            path: Some("/tmp/shuck".to_string()),
            arguments: Some(vec!["server".to_string(), "--isolated".to_string()]),
            env: None,
        };

        assert_eq!(
            resolve_arguments(Some(&settings)),
            vec!["server".to_string(), "--isolated".to_string()]
        );
    }

    #[test]
    fn configured_path_is_used_when_present() {
        let settings = super::zed::settings::CommandSettings {
            path: Some("/custom/path/shuck".to_string()),
            arguments: None,
            env: None,
        };

        assert_eq!(
            configured_command_path(Some(&settings)).unwrap(),
            Some("/custom/path/shuck".to_string())
        );
    }

    #[test]
    fn empty_configured_path_is_rejected() {
        let settings = super::zed::settings::CommandSettings {
            path: Some("  ".to_string()),
            arguments: None,
            env: None,
        };

        assert!(configured_command_path(Some(&settings)).is_err());
    }

    #[test]
    fn configured_environment_is_forwarded() {
        let mut values = HashMap::new();
        values.insert("SHUCK_EXPERIMENTAL".to_string(), "1".to_string());

        let environment = hash_map_into_env(values);

        assert_eq!(
            environment,
            vec![("SHUCK_EXPERIMENTAL".to_string(), "1".to_string())]
        );
    }
}
