> [!IMPORTANT]
> This is a  archived legacy project and is no longer maintained, Use latest plugin called [Secure-Smart-Sync](https://github.com/Secure-Smart-Sync/Secure-Smart-Sync) for advance obsidian sync methods, you can still use the following plugin if backing up files using local git is your goal.

# Seamless Git Backup

A lightweight Obsidian plugin that enables one-click Git backups directly from within your vault.

This plugin is designed for users who want a frictionless way to back up their Obsidian vault to a remote Git repository such as GitHub without manually opening a terminal or running Git commands themselves.

Instead of relying on external scripts or command-line workflows, Seamless Git Backup integrates directly into Obsidian and performs the backup process internally through a single button or command.

---

## Features

* One-click vault backup directly inside Obsidian
* Automatic Git staging, commit, and push workflow
* Ribbon button integration for quick access
* Command palette support
* Built-in backup status notifications
* Prevents empty commits when no changes exist
* Uses system-installed Git for reliability
* Desktop-only support for compatibility and stability

---

## How It Works

When triggered, the plugin performs the following operations:

1. Stages all modified vault files using `git add .`
2. Checks whether staged changes exist
3. Creates a commit if changes are detected
4. Pushes the commit to the configured remote repository

If no changes are detected, the plugin safely exits without creating unnecessary commits.

All Git operations are executed using your system's installed Git executable.

---

## Requirements

Before using this plugin, the following prerequisites must be met:

### 1. Git Must Be Installed

Ensure Git is installed and accessible from your system terminal.

To verify:

```bash
git --version
```

If Git is installed correctly, this command should return your installed Git version.

---

### 2. Your Vault Must Be a Git Repository

Your Obsidian vault folder must already be initialized as a Git repository.

---

### 3. A Remote Repository Must Be Configured

A Git remote (such as GitHub) must already be linked to the vault repository.

---

## Installation

### Manual Installation

1. Download or clone this repository
2. Place the plugin folder inside your vault:

```bash
<your-vault>/.obsidian/plugins/seamless-git-backup
```

3. Install dependencies:

```bash
npm install
```

4. Build the plugin:

```bash
npm run build
```

5. Open Obsidian
6. Navigate to:

```text
Settings → Community Plugins
```

7. Enable **Seamless Git Backup**

---

## Initial Git Setup Guide

If your vault is not yet configured for Git backup, follow these steps.

---

### Step 1: Navigate to Your Vault Folder

Open terminal in your vault directory:

```bash
cd path/to/your/vault
```

---

### Step 2: Initialize Git

```bash
git init
```

---

### Step 3: Create a `.gitignore` File

Recommended `.gitignore`:

```gitignore
**/node_modules/
.obsidian/plugins/*/node_modules/
.obsidian/plugins/*/dist/
.obsidian/plugins/*/build/
*.log
.DS_Store
Thumbs.db
```

---

### Step 4: Add Files

```bash
git add .
```

---

### Step 5: Commit Initial Backup

```bash
git commit -m "Initial vault backup"
```

---

### Step 6: Set Main Branch

```bash
git branch -M main
```

---

### Step 7: Connect Remote Repository

```bash
git remote add origin <your-repository-url>
```

Example:

```bash
git remote add origin https://github.com/username/repository.git
```

---

### Step 8: Push Initial Backup

```bash
git push -u origin main
```

---

## Usage

Once configured:

### Backup via Ribbon Button

Click the backup icon in the left ribbon.

---

### Backup via Command Palette

1. Open command palette:

```text
Ctrl/Cmd + P
```

2. Search:

```text
Seamless Git Backup
```

3. Run the command.

---

## Recommended Workflow

For best results:

* Use backups after meaningful writing sessions
* Avoid editing files during active backup execution
* Ensure internet connectivity before pushing
* Regularly verify remote backups on GitHub

---

## Troubleshooting

### Git Not Found

If the plugin reports Git is missing:

* Ensure Git is installed
* Ensure Git is available in your system PATH
* Restart Obsidian after installing Git

---

### Backup Fails Due to Authentication

Ensure your Git remote authentication is configured properly.

GitHub users should use:

* Personal Access Token
* SSH authentication

---

### Push Rejected

If remote contains newer changes:

Pull latest changes manually:

```bash
git pull --rebase
```

Then retry backup.

---

### No Changes Detected

The plugin will skip backup if no modified files exist.

This is expected behavior.

---

## Limitations

* Desktop only
* Requires Git to be installed locally
* Does not initialize repositories automatically
* Does not currently perform pull/rebase before push

---

## License

This project is licensed under the AGPL License.

See the LICENSE file for details.

---

## Contributing

Contributions, improvements, and issue reports are welcome.

Please open an issue or submit a pull request if you would like to contribute.

---
