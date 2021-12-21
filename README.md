# git-autoconfig

Working with git repos where you can have multiple emails (like one for work, one for github, one for bitbucket, etc...) can be painful. This extension forces you to set locally user.email and user.name for each project under git that you open with vscode.

## Features

- Convenient selector of previous used pairs of user.email and user.name.

![status bar](media/demo.gif)

## Extension Settings

This extension contributes the following settings:

- `git-autoconfig.queryInterval`: Interval for querying of git config in ms
- `git-autoconfig.configList`: List of local git configs in format [{'user.email': 'Marvolo@Riddle.Tom', 'user.name': 'Tom Marvolo Riddle'}] . Extension itself writes into this setting too.
