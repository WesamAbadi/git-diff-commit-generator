// src/extension.ts (relevant parts)
import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

console.log("!!! MODULE LOADED: src/extension.ts !!!"); // Keep this

// --- Helper Function for Default Prompt ---
function getDefaultPrompt(): string {
    return "Read the diffs attached and give me a commit message in this form:\n" +
           "modified(*file/path*) to change this and this\n" +
           "You can choose (modified, deleted, added) and the message can be anything like change, fix, add, etc.\n" +
           "Keep it short and clean and in the same form, keeping the path inside () and a new line between each mod line.";
}

// Store commit message history
const commitMessageHistory: string[] = [];
const MAX_HISTORY_SIZE = 10;

export function activate(context: vscode.ExtensionContext) {
  console.log("Activating git-diff-commit-generator...");
  // vscode.window.showInformationMessage("Minimal Activation Successful!3"); // Less noisy

  // Register the main command
  let generateCommand = vscode.commands.registerCommand(
    "git-diff-commit-generator.generateCommitMessage",
    async (context) => {
        console.log("Command: generateCommitMessage triggered", context);
        
        try {
            const config = vscode.workspace.getConfiguration("gitDiffCommitGenerator");
            const apiKey = config.get<string>("apiKey");
            const alwaysUseGeneratedMessage = config.get<boolean>("alwaysUseGeneratedMessage") || false;
            const selectedModel = config.get<string>("selectedModel") || "gemini-2.0-flash";

            if (!apiKey) {
                vscode.window.showWarningMessage("Gemini API key not set. Please set it first via the sidebar or the command palette.");
                return;
            }

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: "Generating commit message",
                    cancellable: false,
                },
                async (progress) => {
                    // Check if we have a repository from context (SCM view)
                    let selectedRepo: { path: string, name: string, workspaceFolder: vscode.WorkspaceFolder } | undefined;
                    
                    // Get the git extension
                    const gitExtension = vscode.extensions.getExtension("vscode.git")?.exports;
                    const api = gitExtension?.getAPI(1);
                    
                    // If called from SCM view, try to get the active repository
                    if (api && api.repositories.length > 0) {
                        const activeRepo = api.repositories.find((r: any) => r.ui.selected);
                        
                        if (activeRepo) {
                            // We found the active repository from SCM
                            const repoPath = activeRepo.rootUri.fsPath;
                            const workspaceFolder = vscode.workspace.workspaceFolders?.find(
                                folder => repoPath.startsWith(folder.uri.fsPath)
                            );
                            
                            if (workspaceFolder) {
                                selectedRepo = {
                                    path: repoPath,
                                    name: workspaceFolder.name + (repoPath === workspaceFolder.uri.fsPath ? '' : 
                                        '/' + path.relative(workspaceFolder.uri.fsPath, repoPath)),
                                    workspaceFolder: workspaceFolder
                                };
                            }
                        }
                    }
                    
                    // If we don't have a selected repo yet, get all repos and prompt user
                    if (!selectedRepo) {
                        progress.report({ message: "Finding git repositories..." });
                        const repositories = await getGitRepositories();
                        
                        if (repositories.length === 0) {
                            vscode.window.showErrorMessage("No git repositories found in workspace");
                            return;
                        }
                        
                        if (repositories.length > 1) {
                            const repoItems = repositories.map(repo => ({
                                label: repo.name,
                                description: repo.path,
                                repo: repo
                            }));
                            
                            const selection = await vscode.window.showQuickPick(repoItems, {
                                placeHolder: 'Select a git repository',
                            });
                            
                            if (!selection) {
                                return; // User cancelled
                            }
                            selectedRepo = selection.repo;
                        } else {
                            selectedRepo = repositories[0];
                        }
                    }

                    if (!selectedRepo) {
                        return;
                    }

                    progress.report({ message: "Getting staged changes..." });
                    console.log("Getting staged diff...");

                    const stagedDiff = await getStagedDiff(selectedRepo.path);
                    if (!stagedDiff && stagedDiff !== "") {
                        return;
                    }
                    if (stagedDiff === "") {
                        vscode.window.showInformationMessage("No staged changes found.");
                        console.log("No staged changes found.");
                        return;
                    }

                    progress.report({ message: "Generating commit message with Gemini..." });
                    console.log("Getting prompt template...");
                    const promptTemplate = config.get<string>("prompt") || getDefaultPrompt();

                    console.log("Calling Gemini API...");
                    const commitMessage = await generateCommitMessage(apiKey, promptTemplate, stagedDiff, selectedModel);

                    if (commitMessage) {
                        console.log("Commit message generated:", commitMessage);
                        
                        // Add to history
                        if (!commitMessageHistory.includes(commitMessage)) {
                            commitMessageHistory.unshift(commitMessage);
                            if (commitMessageHistory.length > MAX_HISTORY_SIZE) {
                                commitMessageHistory.pop();
                            }
                        }
                        
                        provider.clearGeneratingStatus();
                        
                        if (alwaysUseGeneratedMessage) {
                            const gitExtension = vscode.extensions.getExtension("vscode.git")?.exports;
                            const api = gitExtension?.getAPI(1);
                            if (api && api.repositories.length > 0) {
                                // Find the correct repository
                                const repo = api.repositories.find((r: { rootUri: { fsPath: string } }) => {
                                    const path = r.rootUri.fsPath;
                                    return path === selectedRepo?.path;
                                });
                                
                                if (repo) {
                                    repo.inputBox.value = commitMessage;
                                    vscode.window.showInformationMessage("Commit message applied to Git input box.");
                                } else {
                                    await vscode.env.clipboard.writeText(commitMessage);
                                    vscode.window.showWarningMessage("Commit message copied to clipboard (Git repository not found).");
                                }
                            } else {
                                await vscode.env.clipboard.writeText(commitMessage);
                                vscode.window.showWarningMessage("Commit message copied to clipboard (Git extension not available).");
                            }
                        } else {
                            const selection = await vscode.window.showInformationMessage(
                                "Generated commit message:",
                                { modal: true, detail: commitMessage },
                                "Use This Message",
                                "Copy to Clipboard",
                                "Cancel"
                            );

                            if (selection === "Use This Message") {
                                const gitExtension = vscode.extensions.getExtension("vscode.git")?.exports;
                                const api = gitExtension?.getAPI(1);
                                if (api && api.repositories.length > 0) {
                                    // Find the correct repository
                                    const repo = api.repositories.find((r: { rootUri: { fsPath: string } }) => {
                                        const path = r.rootUri.fsPath;
                                        return path === selectedRepo?.path;
                                    });
                                    
                                    if (repo) {
                                        repo.inputBox.value = commitMessage;
                                        vscode.window.showInformationMessage("Commit message applied to Git input box.");
                                    } else {
                                        await vscode.env.clipboard.writeText(commitMessage);
                                        vscode.window.showWarningMessage("Commit message copied to clipboard (Git repository not found).");
                                    }
                                } else {
                                    await vscode.env.clipboard.writeText(commitMessage);
                                    vscode.window.showWarningMessage("Commit message copied to clipboard (Git extension not available).");
                                }
                            } else if (selection === "Copy to Clipboard") {
                                await vscode.env.clipboard.writeText(commitMessage);
                                vscode.window.showInformationMessage("Commit message copied to clipboard.");
                            }
                        }
                    } else {
                        console.log("Generation resulted in empty message.");
                        provider.clearGeneratingStatus();
                        vscode.window.showWarningMessage("Failed to generate commit message (empty response).");
                    }
                }
            );
        } catch (error: any) {
            console.error(`Error in generateCommitMessage command:`, error);
            provider.clearGeneratingStatus();
            vscode.window.showErrorMessage(`Error generating commit message: ${error.message}`);
        }
    }
  );

  // Register the API key setting command
  let setApiKeyCommand = vscode.commands.registerCommand(
    "git-diff-commit-generator.setApiKey",
    async () => {
        console.log("Command: setApiKey triggered");
        const config = vscode.workspace.getConfiguration("gitDiffCommitGenerator");
        const currentKey = config.get<string>("apiKey") || "";

        const apiKey = await vscode.window.showInputBox({
            title: "Set Gemini API Key",
            prompt: "Enter your Gemini API key (leave empty to clear)",
            password: true,
            value: currentKey,
            ignoreFocusOut: true, // Keep open if focus lost
        });

        // Check if the user cancelled (apiKey === undefined)
        // Allow setting an empty string to clear the key
        if (apiKey !== undefined) {
            await config.update("apiKey", apiKey, vscode.ConfigurationTarget.Global);
            if (apiKey) {
                vscode.window.showInformationMessage("Gemini API key saved.");
                console.log("API key saved.");
            } else {
                vscode.window.showInformationMessage("Gemini API key cleared.");
                 console.log("API key cleared.");
            }
            // No need to explicitly update the webview here,
            // the onDidChangeConfiguration listener in the provider will handle it.
        } else {
            console.log("API key setting cancelled.");
        }
    }
  );

  // Register command to show commit message history
  let showHistoryCommand = vscode.commands.registerCommand(
    "git-diff-commit-generator.showCommitHistory",
    async () => {
        if (commitMessageHistory.length === 0) {
            vscode.window.showInformationMessage("No commit message history available.");
            return;
        }

        const items = commitMessageHistory.map((message, index) => {
            // Create a shortened preview of the message
            const preview = message.length > 50 ? 
                message.substring(0, 47) + "..." : 
                message;
            
            return {
                label: `${index + 1}. ${preview}`,
                description: new Date().toLocaleString(), // Could store timestamps with messages for better info
                message: message
            };
        });

        const selection = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a previous commit message',
        });

        if (selection) {
            // Get the git extension
            const gitExtension = vscode.extensions.getExtension("vscode.git")?.exports;
            const api = gitExtension?.getAPI(1);
            
            if (api && api.repositories.length > 0) {
                const activeRepo = api.repositories.find((r: any) => r.ui.selected);
                
                if (activeRepo) {
                    activeRepo.inputBox.value = selection.message;
                    vscode.window.showInformationMessage("Previous commit message applied.");
                } else {
                    await vscode.env.clipboard.writeText(selection.message);
                    vscode.window.showInformationMessage("Previous commit message copied to clipboard.");
                }
            } else {
                await vscode.env.clipboard.writeText(selection.message);
                vscode.window.showInformationMessage("Previous commit message copied to clipboard.");
            }
        }
    }
  );

  // Create and register the sidebar provider
  const provider = new CommitMessageViewProvider(context.extensionUri, context);
  console.log("Registering WebviewViewProvider for gitDiffCommitGeneratorView...");

  // *** This is the crucial registration step ***
  const registration = vscode.window.registerWebviewViewProvider(
      "gitDiffCommitGeneratorView", // Must match package.json view ID
      provider,
      {
          webviewOptions: { retainContextWhenHidden: true } // Keep state when view is hidden
      }
  );
  context.subscriptions.push(registration); // Add the registration disposable

  console.log("WebviewViewProvider registration pushed to subscriptions.");
  // vscode.window.showInformationMessage("Minimal Activation Successful!5"); // Less noisy

  console.log("Pushing commands to subscriptions...");
  context.subscriptions.push(generateCommand);
  context.subscriptions.push(setApiKeyCommand);
  context.subscriptions.push(showHistoryCommand);
  console.log("Commands pushed.");

  console.log("ACTIVATE END");
} // activate function ends

async function getGitRepositories(): Promise<Array<{ path: string, name: string, workspaceFolder: vscode.WorkspaceFolder }>> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return [];
    }

    const repositories: Array<{ path: string, name: string, workspaceFolder: vscode.WorkspaceFolder }> = [];

    for (const folder of workspaceFolders) {
        // First check if the workspace folder itself is a git repo
        try {
            await new Promise((resolve, reject) => {
                cp.exec("git rev-parse --git-dir", { cwd: folder.uri.fsPath }, (error, stdout, stderr) => {
                    if (!error) {
                        repositories.push({
                            path: folder.uri.fsPath,
                            name: folder.name,
                            workspaceFolder: folder
                        });
                    }
                    resolve(null);
                });
            });
        } catch (error) {
            console.log(`Not a git repository at root: ${folder.uri.fsPath}`);
        }

        // Then look for git repositories in subdirectories
        try {
            const result = await new Promise<string>((resolve, reject) => {
                cp.exec("find . -name .git -type d", { cwd: folder.uri.fsPath }, (error, stdout, stderr) => {
                    if (error) {
                        resolve('');
                        return;
                    }
                    resolve(stdout);
                });
            });

            const subRepos = result.trim().split('\n')
                .filter(path => path) // Remove empty strings
                .map(path => path.replace('/.git', '')) // Remove .git from path
                .map(path => path.replace('./', '')); // Remove leading ./

            for (const subPath of subRepos) {
                const fullPath = path.join(folder.uri.fsPath, subPath);
                // Don't add if we already have this repository
                if (!repositories.some(repo => repo.path === fullPath)) {
                    repositories.push({
                        path: fullPath,
                        name: `${folder.name}/${subPath}`,
                        workspaceFolder: folder
                    });
                }
            }
        } catch (error) {
            console.error(`Error finding git repositories in ${folder.uri.fsPath}:`, error);
        }
    }

    return repositories;
}

async function getStagedDiff(workspacePath: string, subPath?: string): Promise<string> {
    console.log(`Executing 'git diff --cached' in ${workspacePath}${subPath ? '/' + subPath : ''}`);
    const execPath = subPath ? `${workspacePath}/${subPath}` : workspacePath;
    
    return new Promise((resolve, reject) => {
        cp.exec("git diff --cached", { cwd: execPath, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Git diff error: ${error.message}`);
                console.error(`Git diff stderr: ${stderr}`);
                if (stderr.includes("not a git repository")) {
                   reject(new Error("Not a git repository or no HEAD commit yet."));
                } else {
                   reject(new Error(`Failed to get git diff: ${stderr || error.message}`));
                }
                return;
            }
            const diff = stdout.trim();
            console.log(`Git diff output length: ${diff.length}`);
            if (!diff) {
                console.log("No staged changes detected by git diff.");
                resolve(""); // Resolve with empty string for no changes
            } else {
                resolve(diff);
            }
        });
    });
}

// --- generateCommitMessage Function ---
async function generateCommitMessage(apiKey: string, prompt: string, diff: string, selectedModel: string): Promise<string> {
    console.log("Initializing Gemini AI client...");
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: selectedModel });

        const fullPrompt = `${prompt}\n\nHere are the diffs:\n\`\`\`diff\n${diff}\n\`\`\``;
        console.log(`Sending prompt to Gemini (Prompt length: ${prompt.length}, Diff length: ${diff.length})`);

        // *** FIX: Use imported enums ***
        const safetySettings = [
            {
                category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            },
            {
                category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            },
            {
                category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            },
            {
                category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            },
        ];

        const request = {
          contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
          safetySettings: safetySettings,
          // generationConfig: { maxOutputTokens: 800, temperature: 0.7 }
        };

        const result = await model.generateContent(request); // Pass the request object

        const response = await result.response;

        // Check for blocked content (check remains the same)
         if (!response.candidates || response.candidates.length === 0 || !response.candidates[0].content) {
            const blockReason = response.promptFeedback?.blockReason;
            const safetyRatings = response.promptFeedback?.safetyRatings;
            console.warn(`Gemini response potentially blocked. Reason: ${blockReason || 'N/A'}`);
            console.warn('Safety Ratings:', safetyRatings);
            throw new Error(`Generation failed. The response may have been blocked due to safety settings (Reason: ${blockReason || 'No candidate content'}).`);
        }


        const text = response.text();
        console.log("Received text from Gemini:", text);
        return text;
    } catch (error: any) {
        console.error(`Gemini API error: ${error.message}`, error);
        let userMessage = `Gemini API error: ${error.message}`;
        if (error.message && error.message.includes('API key not valid')) {
            userMessage = "Gemini API key is not valid. Please check and set it again.";
        } else if (error.message && error.message.includes('quota')) {
             userMessage = "Gemini API quota exceeded. Please check your usage limits.";
        }
        throw new Error(userMessage);
    }
}

// --- CommitMessageViewProvider Class ---
class CommitMessageViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "gitDiffCommitGeneratorView"; // Consistent view type

    private _view?: vscode.WebviewView;
    private readonly _extensionUri: vscode.Uri;
    private readonly _context: vscode.ExtensionContext;
    private _configChangeListener: vscode.Disposable | undefined;

    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        console.log("CommitMessageViewProvider instance created.");
        this._extensionUri = extensionUri;
        this._context = context;
    }

    // This method is called by VS Code when the view needs to be shown
    resolveWebviewView(
        webviewView: vscode.WebviewView,
        viewContext: vscode.WebviewViewResolveContext, // Renamed parameter for clarity
        _token: vscode.CancellationToken
    ) {
        // Log *immediately* upon entry
        console.log("!!! resolveWebviewView ENTERED !!!");
        this._view = webviewView; // Store reference to the view

        try { // Wrap the entire setup logic
            console.log("Setting up webview options...");
            webviewView.webview.options = {
                // Allow scripts in the webview
                enableScripts: true,
                // Restrict the webview to only loading content from our extension's directory
                localResourceRoots: [this._extensionUri],
            };
            console.log("-> Webview options set.");

            console.log("Setting webview HTML content...");
            webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
            console.log("-> Webview HTML set.");

            console.log("Setting up webview message listener...");
            webviewView.webview.onDidReceiveMessage(async (data) => {
                console.log(`-> Webview message received: command='${data.command}'`, data.value ? `value='${String(data.value).substring(0,50)}...'` : '');
                switch (data.command) {
                    case 'setApiKey':
                        vscode.commands.executeCommand('git-diff-commit-generator.setApiKey');
                        break;
                    case 'generateCommitMessage':
                        vscode.commands.executeCommand('git-diff-commit-generator.generateCommitMessage');
                        break;
                    case 'setPrompt':
                        if (typeof data.value === 'string') {
                            console.log("Saving prompt template...");
                            const config = vscode.workspace.getConfiguration('gitDiffCommitGenerator');
                            try {
                                await config.update('prompt', data.value, vscode.ConfigurationTarget.Global);
                                vscode.window.showInformationMessage('Prompt template saved.');
                                console.log("Prompt template saved successfully.");
                            } catch (error: any) {
                                console.error("Error saving prompt template:", error);
                                vscode.window.showErrorMessage(`Failed to save prompt: ${error.message}`);
                            }
                        } else {
                            console.warn("Received 'setPrompt' command without valid string value.");
                        }
                        break;
                    case 'setModel':
                        if (typeof data.value === 'string') {
                            console.log("Saving model selection...");
                            const config = vscode.workspace.getConfiguration('gitDiffCommitGenerator');
                            try {
                                await config.update('selectedModel', data.value, vscode.ConfigurationTarget.Global);
                                console.log("Model selection saved successfully.");
                            } catch (error: any) {
                                console.error("Error saving model selection:", error);
                                vscode.window.showErrorMessage(`Failed to save model selection: ${error.message}`);
                            }
                        }
                        break;
                    case 'setAlwaysUseGenerated':
                        if (typeof data.value === 'boolean') {
                            console.log("Saving always use generated setting...");
                            const config = vscode.workspace.getConfiguration('gitDiffCommitGenerator');
                            try {
                                await config.update('alwaysUseGeneratedMessage', data.value, vscode.ConfigurationTarget.Global);
                                console.log("Always use generated setting saved successfully.");
                            } catch (error: any) {
                                console.error("Error saving always use generated setting:", error);
                                vscode.window.showErrorMessage(`Failed to save setting: ${error.message}`);
                            }
                        }
                        break;
                    case 'newTemplate':
                        this._createNewTemplate();
                        break;
                    case 'editTemplate':
                        if (typeof data.value === 'string') {
                            this._editTemplate(data.value);
                        }
                        break;
                    case 'deleteTemplate':
                        if (typeof data.value === 'string') {
                            this._deleteTemplate(data.value);
                        }
                        break;
                    case 'getInitialSettings':
                        console.log("Webview requested initial settings. Posting current settings...");
                        this._updateWebviewSettings();
                        break;
                    case 'showCommitHistory':
                        vscode.commands.executeCommand('git-diff-commit-generator.showCommitHistory');
                        break;
                    case 'copyLastCommitMessage':
                        if (commitMessageHistory.length > 0) {
                            await vscode.env.clipboard.writeText(commitMessageHistory[0]);
                            vscode.window.showInformationMessage("Last commit message copied to clipboard.");
                        } else {
                            vscode.window.showInformationMessage("No commit message history available.");
                        }
                        break;
                    default:
                        console.warn(`Received unknown command from webview: ${data.command}`);
                }
            });
            console.log("-> Webview message listener added.");

            // --- Configuration Change Listener ---
            console.log("Setting up configuration change listener...");
            // Dispose any previous listener first
            this._configChangeListener?.dispose();
            this._configChangeListener = vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration("gitDiffCommitGenerator")) {
                    console.log("-> Config changed, posting updated settings to webview...");
                    this._updateWebviewSettings();
                }
            });
            // Add listener disposable to context ONLY ONCE during activation? No, tie to webview lifecycle.
            // this._context.subscriptions.push(this._configChangeListener); // NO - leads to multiple listeners if view recreated

            // Dispose listener when webview is disposed
            webviewView.onDidDispose(() => {
                console.log("!!! resolveWebviewView DISPOSING -> Disposing config listener !!!");
                this._configChangeListener?.dispose();
                this._configChangeListener = undefined; // Clear reference
                this._view = undefined; // Clear view reference
            }, null, this._context.subscriptions); // Add disposable tracking to context

            // --- Initial Settings Update ---
            console.log("Performing initial settings update for webview...");
            this._updateWebviewSettings(); // Send initial state

            console.log("!!! resolveWebviewView setup COMPLETE !!!");

        } catch (e: any) {
            // Log any error that occurs anywhere within resolveWebviewView setup
            console.error("!!! CRITICAL ERROR during resolveWebviewView setup:", e);
            vscode.window.showErrorMessage(`Error setting up Git Commit Generator view: ${e.message}`);
            // Set error HTML so the user sees something is wrong
            webviewView.webview.html = `<html><body><h1>Error Loading View</h1><p>Failed to initialize the Git Commit Generator view.</p><pre>${e.message}\n${e.stack}</pre></body></html>`;
        }
    }

    // Helper method to send current settings to the webview
    private async _updateWebviewSettings() {
        if (!this._view) {
            console.warn("Attempted to update webview settings, but view is not available.");
            return;
        }
        console.log("Fetching current config to send to webview...");
        const config = vscode.workspace.getConfiguration("gitDiffCommitGenerator");
        const apiKey = config.get<string>("apiKey");
        const prompt = config.get<string>("prompt") || getDefaultPrompt();
        const selectedModel = config.get<string>("selectedModel") || "gemini-2.0-flash";
        const alwaysUseGenerated = config.get<boolean>("alwaysUseGeneratedMessage") || false;
        const savedTemplates = config.get<{ [key: string]: any }>("savedTemplates") || {};
        const defaultTemplateId = config.get<string>("defaultTemplateId") || "";

        console.log(`--> Posting 'updateSettings': hasApiKey=${!!apiKey}`);
        this._view.webview.postMessage({
            command: "updateSettings",
            hasApiKey: !!apiKey,
            prompt: prompt,
            selectedModel: selectedModel,
            alwaysUseGenerated: alwaysUseGenerated,
            templates: savedTemplates,
            selectedTemplateId: defaultTemplateId,
            hasHistory: commitMessageHistory.length > 0
        }).then(
            (success) => { if (!success) console.warn("--> postMessage 'updateSettings' returned false."); },
            (error) => { console.error("--> postMessage 'updateSettings' FAILED:", error); }
        );
    }

    // Generates the HTML content for the webview
    private _getHtmlForWebview(webview: vscode.Webview): string {
        console.log("Generating HTML content for webview...");
        const nonce = getNonce();
        
        const htmlContent = `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="
                default-src 'none';
                style-src ${webview.cspSource} 'unsafe-inline';
                script-src 'nonce-${nonce}';
                connect-src 'none';
                img-src ${webview.cspSource} data:;
            ">
            <title>Git Diff Commit Generator</title>
            <style>
                /* Basic Reset & Variables */
                :root {
                    --button-padding: 6px 10px;
                    --section-padding: 10px;
                    --gap: 8px;
                    --border-radius: 4px;
                    --transition: all 0.2s ease;
                }
                body {
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-sideBar-background);
                    padding: 8px;
                    box-sizing: border-box;
                    height: 100vh;
                    display: flex;
                    flex-direction: column;
                    margin: 0;
                }
                *, *::before, *::after {
                    box-sizing: inherit;
                    margin: 0;
                    padding: 0;
                }

                /* Layout */
                .container {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    flex-grow: 1;
                }
                .section {
                    background-color: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
                    padding: var(--section-padding);
                    border-radius: var(--border-radius);
                    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
                    overflow: hidden;
                }
                .section-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-bottom: 6px;
                    cursor: pointer;
                }
                .section-header h3 {
                    display: flex;
                    align-items: center;
                    font-size: 0.9em;
                    font-weight: 600;
                    color: var(--vscode-sideBarTitle-foreground);
                    margin: 0;
                    border: none;
                    padding: 0;
                }
                .section-header h3 span {
                    margin-left: 4px;
                }
                .section-content {
                    display: flex;
                    flex-direction: column;
                    gap: var(--gap);
                }
                .collapsed .section-content {
                    display: none;
                }
                .section-icon {
                    font-size: 0.8em;
                    transition: var(--transition);
                }
                .collapsed .section-icon {
                    transform: rotate(-90deg);
                }
                .emoji-icon {
                    margin-right: 4px;
                }

                /* Elements */
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: var(--button-padding);
                    cursor: pointer;
                    border-radius: var(--border-radius);
                    font-size: 0.9em;
                    font-weight: 500;
                    transition: var(--transition);
                    width: 100%;
                    text-align: center;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                button:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                    outline-offset: 1px;
                }
                button:disabled {
                    background-color: var(--vscode-button-secondaryBackground, var(--vscode-disabledForeground));
                    color: var(--vscode-disabledForeground);
                    cursor: not-allowed;
                    opacity: 0.7;
                }
                textarea {
                    width: 100%;
                    min-height: 80px;
                    max-height: 200px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: var(--border-radius);
                    padding: 6px;
                    font-family: var(--vscode-editor-font-family);
                    font-size: var(--vscode-editor-font-size);
                    resize: vertical;
                    transition: var(--transition);
                }
                textarea:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                    border-color: var(--vscode-focusBorder);
                }

                /* API Key Status */
                .api-key-status {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    margin-bottom: 6px;
                    font-size: 0.85em;
                }
                .api-status-icon {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    flex-shrink: 0;
                }
                .api-status-icon.set {
                    background-color: var(--vscode-testing-iconPassed, green);
                }
                .api-status-icon.not-set {
                    background-color: var(--vscode-errorForeground, red);
                }
                #apiKeyStatusText {
                    color: var(--vscode-descriptionForeground);
                }

                /* Model selection and options */
                select {
                    width: 100%;
                    padding: 6px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: var(--border-radius);
                    font-size: 0.9em;
                    transition: var(--transition);
                }
                select:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                    border-color: var(--vscode-focusBorder);
                }
                .checkbox-container {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 0.85em;
                }
                .checkbox-container input[type="checkbox"] {
                    margin: 0;
                }

                /* Template list */
                .template-list {
                    max-height: 150px;
                    overflow-y: auto;
                    border: 1px solid var(--vscode-input-border);
                    border-radius: var(--border-radius);
                    margin-bottom: 6px;
                    font-size: 0.9em;
                }
                .template-item {
                    padding: 6px 8px;
                    border-bottom: 1px solid var(--vscode-input-border);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    transition: var(--transition);
                }
                .template-item:last-child {
                    border-bottom: none;
                }
                .template-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .template-item.selected {
                    background-color: var(--vscode-list-activeSelectionBackground);
                    color: var(--vscode-list-activeSelectionForeground);
                }
                .template-name {
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    flex: 1;
                }
                .template-actions {
                    display: flex;
                    gap: 4px;
                }
                .template-actions button {
                    padding: 2px 6px;
                    font-size: 0.8em;
                    min-width: 40px;
                }
                .button-row {
                    display: flex;
                    gap: 6px;
                }
                .button-row button {
                    flex: 1;
                }
                .small-text {
                    font-size: 0.8em;
                    color: var(--vscode-descriptionForeground);
                    margin-top: 4px;
                }
                #generateStatus {
                    font-size: 0.8em;
                    text-align: center;
                    min-height: 1.2em;
                    margin-top: 4px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="section">
                    <div class="section-header" id="apiKeyHeader">
                        <h3><span class="emoji-icon">🔑</span> <span>API Key</span></h3>
                        <span class="section-icon">▼</span>
                    </div>
                    <div class="section-content">
                        <div class="api-key-status">
                            <div id="apiKeyStatus" class="api-status-icon not-set"></div>
                            <span id="apiKeyStatusText">Checking...</span>
                        </div>
                        <button id="setApiKeyBtn"><span class="emoji-icon">✏️</span> Set/Update API Key</button>
                    </div>
                </div>

                <div class="section">
                    <div class="section-header" id="modelHeader">
                        <h3><span class="emoji-icon">⚙️</span> <span>Settings</span></h3>
                        <span class="section-icon">▼</span>
                    </div>
                    <div class="section-content">
                        <select id="modelSelect" title="Select which Gemini model to use">
                            <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                            <option value="gemini-2.0-flash-lite">Gemini 2.0 Flash Lite</option>
                            <option value="gemini-2.5-flash-preview-05-20">Gemini 2.5 Flash Preview</option>
                            <option value="gemini-2.5-pro-preview-05-06">Gemini 2.5 Pro</option>
                        </select>
                        <div class="checkbox-container">
                            <input type="checkbox" id="alwaysUseGenerated" />
                            <label for="alwaysUseGenerated">Always use generated message</label>
                        </div>
                    </div>
                </div>

                <div class="section">
                    <div class="section-header">
                        <h3><span class="emoji-icon">✨</span> <span>Generate</span></h3>
                    </div>
                    <div class="section-content">
                        <button id="generateBtn" disabled><span class="emoji-icon">✨</span> Generate Commit Message</button>
                        <div class="button-row" style="margin-top: 6px;">
                            <button id="historyBtn"><span class="emoji-icon">🕒</span> History</button>
                            <button id="copyBtn"><span class="emoji-icon">📋</span> Copy Last</button>
                        </div>
                        <div id="generateStatus"></div>
                    </div>
                </div>

                <div class="section">
                    <div class="section-header" id="templatesHeader">
                        <h3><span class="emoji-icon">📚</span> <span>Templates</span></h3>
                        <span class="section-icon">▼</span>
                    </div>
                    <div class="section-content">
                        <div class="template-list" id="templateList">
                            <!-- Templates will be populated here -->
                        </div>
                        <div class="button-row">
                            <button id="newTemplateBtn"><span class="emoji-icon">➕</span> New</button>
                            <button id="editTemplateBtn"><span class="emoji-icon">✏️</span> Edit</button>
                        </div>
                        <textarea id="promptTemplate" placeholder="Enter your custom prompt template..."></textarea>
                        <button id="savePromptBtn"><span class="emoji-icon">💾</span> Save Template</button>
                    </div>
                </div>
            </div>

            <script nonce="${nonce}">
                (function() {
                    if (typeof acquireVsCodeApi === 'function') {
                        const vscode = acquireVsCodeApi();

                        // --- Elements ---
                        const apiKeyStatusIcon = document.getElementById('apiKeyStatus');
                        const apiKeyStatusText = document.getElementById('apiKeyStatusText');
                        const setApiKeyBtn = document.getElementById('setApiKeyBtn');
                        const generateBtn = document.getElementById('generateBtn');
                        const promptTemplate = document.getElementById('promptTemplate');
                        const savePromptBtn = document.getElementById('savePromptBtn');
                        const generateStatus = document.getElementById('generateStatus');
                        const modelSelect = document.getElementById('modelSelect');
                        const alwaysUseGenerated = document.getElementById('alwaysUseGenerated');
                        const templateList = document.getElementById('templateList');
                        const newTemplateBtn = document.getElementById('newTemplateBtn');
                        const editTemplateBtn = document.getElementById('editTemplateBtn');
                        const historyBtn = document.getElementById('historyBtn');
                        const copyBtn = document.getElementById('copyBtn');
                        
                        // Section headers for collapsible sections
                        const apiKeyHeader = document.getElementById('apiKeyHeader');
                        const modelHeader = document.getElementById('modelHeader');
                        const templatesHeader = document.getElementById('templatesHeader');

                        // --- State ---
                        let currentApiKeySet = false;
                        let currentTemplates = {};
                        let selectedTemplateId = null;
                        const previousState = vscode.getState() || { 
                            hasApiKey: false, 
                            prompt: '',
                            selectedModel: 'gemini-2.0-flash',
                            alwaysUseGenerated: false,
                            templates: {},
                            selectedTemplateId: null,
                            collapsedSections: {
                                apiKey: false,
                                model: false,
                                templates: false
                            }
                        };
                        console.log('Initial webview state:', previousState);

                        // --- Functions ---
                        function updateApiKeyStatus(hasApiKey) {
                            currentApiKeySet = hasApiKey;
                            if (hasApiKey) {
                                apiKeyStatusIcon.className = 'api-status-icon set';
                                apiKeyStatusText.textContent = 'API Key is set';
                                generateBtn.disabled = false;
                                generateBtn.title = 'Generate commit message from staged changes';
                            } else {
                                apiKeyStatusIcon.className = 'api-status-icon not-set';
                                apiKeyStatusText.textContent = 'API Key not set';
                                generateBtn.disabled = true;
                                generateBtn.title = 'Set your Gemini API Key first';
                            }
                        }

                        function updatePrompt(promptValue) {
                            promptTemplate.value = promptValue || '';
                        }

                        function updateTemplateList(templates) {
                            currentTemplates = templates || {};
                            templateList.innerHTML = '';
                            
                            if (Object.keys(currentTemplates).length === 0) {
                                const emptyItem = document.createElement('div');
                                emptyItem.className = 'template-item';
                                emptyItem.textContent = 'No templates yet. Create one!';
                                templateList.appendChild(emptyItem);
                                return;
                            }
                            
                            Object.entries(currentTemplates).forEach(([id, template]) => {
                                const div = document.createElement('div');
                                div.className = 'template-item';
                                if (id === selectedTemplateId) {
                                    div.classList.add('selected');
                                }
                                div.dataset.id = id;

                                const nameSpan = document.createElement('span');
                                nameSpan.className = 'template-name';
                                nameSpan.textContent = template.name;
                                nameSpan.title = template.name;
                                div.appendChild(nameSpan);

                                const actionsDiv = document.createElement('div');
                                actionsDiv.className = 'template-actions';
                                
                                const useBtn = document.createElement('button');
                                useBtn.innerHTML = '<span class="emoji-icon">✓</span>';
                                useBtn.title = 'Use this template';
                                useBtn.onclick = (e) => {
                                    e.stopPropagation();
                                    selectedTemplateId = id;
                                    promptTemplate.value = template.prompt;
                                    saveState();
                                    updateTemplateList(currentTemplates);
                                };
                                
                                const deleteBtn = document.createElement('button');
                                deleteBtn.innerHTML = '<span class="emoji-icon">🗑️</span>';
                                deleteBtn.title = 'Delete this template';
                                deleteBtn.onclick = (e) => {
                                    e.stopPropagation();
                                    vscode.postMessage({ 
                                        command: 'deleteTemplate',
                                        value: id
                                    });
                                };

                                actionsDiv.appendChild(useBtn);
                                actionsDiv.appendChild(deleteBtn);
                                div.appendChild(actionsDiv);
                                
                                // Make the whole item clickable to select template
                                div.addEventListener('click', () => {
                                    selectedTemplateId = id;
                                    promptTemplate.value = template.prompt;
                                    saveState();
                                    updateTemplateList(currentTemplates);
                                });
                                
                                templateList.appendChild(div);
                            });
                        }

                        function toggleSection(sectionEl, sectionName) {
                            const isCollapsed = sectionEl.classList.toggle('collapsed');
                            const collapsedSections = previousState.collapsedSections || {};
                            collapsedSections[sectionName] = isCollapsed;
                            saveState();
                        }

                        function restoreCollapsedState() {
                            const collapsedSections = previousState.collapsedSections || {};
                            
                            if (collapsedSections.apiKey) {
                                apiKeyHeader.parentElement.classList.add('collapsed');
                            }
                            
                            if (collapsedSections.model) {
                                modelHeader.parentElement.classList.add('collapsed');
                            }
                            
                            if (collapsedSections.templates) {
                                templatesHeader.parentElement.classList.add('collapsed');
                            }
                        }

                        function saveState() {
                            const collapsedSections = {
                                apiKey: apiKeyHeader.parentElement.classList.contains('collapsed'),
                                model: modelHeader.parentElement.classList.contains('collapsed'),
                                templates: templatesHeader.parentElement.classList.contains('collapsed')
                            };
                            
                            vscode.setState({
                                hasApiKey: currentApiKeySet,
                                prompt: promptTemplate.value,
                                selectedModel: modelSelect.value,
                                alwaysUseGenerated: alwaysUseGenerated.checked,
                                templates: currentTemplates,
                                selectedTemplateId,
                                collapsedSections
                            });
                            console.log('Webview state saved.');
                        }

                        // --- Event listeners ---
                        setApiKeyBtn.addEventListener('click', () => {
                            console.log('Set API Key button clicked');
                            generateStatus.textContent = '';
                            vscode.postMessage({ command: 'setApiKey' });
                        });

                        generateBtn.addEventListener('click', () => {
                            console.log('Generate button clicked');
                            if (!generateBtn.disabled) {
                                generateStatus.textContent = 'Generating...';
                                vscode.postMessage({ command: 'generateCommitMessage' });
                            }
                        });

                        savePromptBtn.addEventListener('click', () => {
                            console.log('Save Prompt button clicked');
                            generateStatus.textContent = '';
                            vscode.postMessage({
                                command: 'setPrompt',
                                value: promptTemplate.value
                            });
                        });

                        modelSelect.addEventListener('change', () => {
                            console.log('Model selection changed');
                            vscode.postMessage({
                                command: 'setModel',
                                value: modelSelect.value
                            });
                            saveState();
                        });

                        alwaysUseGenerated.addEventListener('change', () => {
                            console.log('Always use generated changed');
                            vscode.postMessage({
                                command: 'setAlwaysUseGenerated',
                                value: alwaysUseGenerated.checked
                            });
                            saveState();
                        });

                        newTemplateBtn.addEventListener('click', () => {
                            console.log('New template button clicked');
                            vscode.postMessage({ command: 'newTemplate' });
                        });

                        editTemplateBtn.addEventListener('click', () => {
                            if (selectedTemplateId) {
                                console.log('Edit template button clicked');
                                vscode.postMessage({ 
                                    command: 'editTemplate',
                                    value: selectedTemplateId
                                });
                            } else {
                                vscode.postMessage({ command: 'newTemplate' });
                            }
                        });

                        historyBtn.addEventListener('click', () => {
                            console.log('History button clicked');
                            vscode.postMessage({ command: 'showCommitHistory' });
                        });

                        copyBtn.addEventListener('click', () => {
                            console.log('Copy button clicked');
                            vscode.postMessage({ command: 'copyLastCommitMessage' });
                        });

                        promptTemplate.addEventListener('blur', saveState);
                        
                        // Collapsible section handlers
                        apiKeyHeader.addEventListener('click', () => toggleSection(apiKeyHeader.parentElement, 'apiKey'));
                        modelHeader.addEventListener('click', () => toggleSection(modelHeader.parentElement, 'model'));
                        templatesHeader.addEventListener('click', () => toggleSection(templatesHeader.parentElement, 'templates'));

                        // --- Handle messages from extension ---
                        window.addEventListener('message', event => {
                            const message = event.data;
                            console.log('Webview received command:', message.command);

                            switch (message.command) {
                                case 'updateSettings':
                                    console.log('Updating UI from received settings:', message);
                                    updateApiKeyStatus(message.hasApiKey);
                                    updatePrompt(message.prompt);
                                    modelSelect.value = message.selectedModel || 'gemini-2.0-flash';
                                    alwaysUseGenerated.checked = message.alwaysUseGenerated || false;
                                    updateTemplateList(message.templates);
                                    selectedTemplateId = message.selectedTemplateId;
                                    generateStatus.textContent = '';
                                    currentApiKeySet = message.hasApiKey;
                                    saveState();
                                    break;
                                case 'clearGeneratingStatus':
                                    generateStatus.textContent = '';
                                    break;
                            }
                        });

                        // --- Initialization ---
                        console.log('Webview script initializing...');
                        updateApiKeyStatus(previousState.hasApiKey);
                        updatePrompt(previousState.prompt);
                        modelSelect.value = previousState.selectedModel;
                        alwaysUseGenerated.checked = previousState.alwaysUseGenerated;
                        updateTemplateList(previousState.templates);
                        selectedTemplateId = previousState.selectedTemplateId;
                        restoreCollapsedState();
                        console.log('Requesting initial settings from extension...');
                        vscode.postMessage({ command: 'getInitialSettings' });

                    } else {
                        console.error("acquireVsCodeApi is not available. Webview cannot communicate with the extension.");
                        document.body.innerHTML = '<div style="padding: 20px; color: var(--vscode-errorForeground);">Error: Cannot initialize communication with VS Code.</div>';
                    }
                }());
            </script>
        </body>
        </html>`;
        console.log("-> HTML content generated.");
        return htmlContent;
    }

    private async _createNewTemplate() {
        const name = await vscode.window.showInputBox({
            prompt: "Enter a name for the new template",
            placeHolder: "e.g., Conventional Commits",
        });

        if (!name) return; // User cancelled

        const prompt = await vscode.window.showInputBox({
            prompt: "Enter the prompt template",
            placeHolder: "Enter your prompt template...",
            value: getDefaultPrompt(),
        });

        if (!prompt) return; // User cancelled

        const config = vscode.workspace.getConfiguration('gitDiffCommitGenerator');
        const templates = config.get<{ [key: string]: any }>('savedTemplates') || {};
        const id = `template_${Date.now()}`;

        templates[id] = {
            name,
            prompt,
            projectPaths: []
        };

        try {
            await config.update('savedTemplates', templates, vscode.ConfigurationTarget.Global);
            this._updateWebviewSettings();
            vscode.window.showInformationMessage(`Template "${name}" created successfully.`);
        } catch (error: any) {
            console.error("Error creating template:", error);
            vscode.window.showErrorMessage(`Failed to create template: ${error.message}`);
        }
    }

    private async _editTemplate(templateId: string) {
        const config = vscode.workspace.getConfiguration('gitDiffCommitGenerator');
        const templates = config.get<{ [key: string]: any }>('savedTemplates') || {};
        const template = templates[templateId];

        if (!template) {
            vscode.window.showErrorMessage("Template not found.");
            return;
        }

        const name = await vscode.window.showInputBox({
            prompt: "Edit template name",
            value: template.name,
        });

        if (!name) return; // User cancelled

        const prompt = await vscode.window.showInputBox({
            prompt: "Edit prompt template",
            value: template.prompt,
        });

        if (!prompt) return; // User cancelled

        templates[templateId] = {
            ...template,
            name,
            prompt
        };

        try {
            await config.update('savedTemplates', templates, vscode.ConfigurationTarget.Global);
            this._updateWebviewSettings();
            vscode.window.showInformationMessage(`Template "${name}" updated successfully.`);
        } catch (error: any) {
            console.error("Error updating template:", error);
            vscode.window.showErrorMessage(`Failed to update template: ${error.message}`);
        }
    }

    private async _deleteTemplate(templateId: string) {
        const config = vscode.workspace.getConfiguration('gitDiffCommitGenerator');
        const templates = config.get<{ [key: string]: any }>('savedTemplates') || {};
        
        if (!templates[templateId]) {
            vscode.window.showErrorMessage("Template not found.");
            return;
        }

        const name = templates[templateId].name;
        delete templates[templateId];

        try {
            await config.update('savedTemplates', templates, vscode.ConfigurationTarget.Global);
            
            // If this was the default template, clear that setting
            const defaultTemplateId = config.get<string>('defaultTemplateId');
            if (defaultTemplateId === templateId) {
                await config.update('defaultTemplateId', '', vscode.ConfigurationTarget.Global);
            }

            this._updateWebviewSettings();
            vscode.window.showInformationMessage(`Template "${name}" deleted successfully.`);
        } catch (error: any) {
            console.error("Error deleting template:", error);
            vscode.window.showErrorMessage(`Failed to delete template: ${error.message}`);
        }
    }

    public clearGeneratingStatus() {
        if (this._view) {
            this._view.webview.postMessage({ command: 'clearGeneratingStatus' });
        }
    }
}

// --- Helper to generate nonce ---
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}


// --- Deactivate Function ---
export function deactivate() {
     console.log("Deactivating git-diff-commit-generator...");
     // Cleanup happens automatically via context.subscriptions
}