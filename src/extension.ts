// src/extension.ts (relevant parts)
import * as vscode from "vscode";
import * as cp from "child_process";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

console.log("!!! MODULE LOADED: src/extension.ts !!!"); // Keep this

// --- Helper Function for Default Prompt ---
function getDefaultPrompt(): string {
    return "Read the diffs attached and give me a commit message in this form:\n" +
           "modified(*file/path*) to change this and this\n" +
           "You can choose (modified, deleted, added) and the message can be anything like change, fix, add, etc.\n" +
           "Keep it short and clean and in the same form, keeping the () and a new line between each mod line.";
}


export function activate(context: vscode.ExtensionContext) {
  console.log("Activating git-diff-commit-generator...");
  // vscode.window.showInformationMessage("Minimal Activation Successful!3"); // Less noisy

  // Register the main command
  let generateCommand = vscode.commands.registerCommand(
    "git-diff-commit-generator.generateCommitMessage",
    async () => {
        console.log("Command: generateCommitMessage triggered");
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage("No workspace folder found");
            return;
        }

        try {
            const config = vscode.workspace.getConfiguration("gitDiffCommitGenerator");
            const apiKey = config.get<string>("apiKey");

            if (!apiKey) {
                vscode.window.showWarningMessage("Gemini API key not set. Please set it first via the sidebar or the command palette.");
                // Optionally focus the view:
                // vscode.commands.executeCommand('gitDiffCommitGeneratorView.focus');
                return;
            }

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: "Generating commit message",
                    cancellable: false, // Consider making cancellable later
                },
                async (progress) => {
                    progress.report({ message: "Getting staged changes..." });
                    console.log("Getting staged diff...");

                    const stagedDiff = await getStagedDiff(workspaceFolder.uri.fsPath);
                    if (!stagedDiff && stagedDiff !== "") { // Handle potential error from getStagedDiff if it rejects
                       // Error was already shown by getStagedDiff or caught below
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
                    const commitMessage = await generateCommitMessage(apiKey, promptTemplate, stagedDiff);

                    if (commitMessage) {
                        console.log("Commit message generated:", commitMessage);
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
                                // Use the first repository found
                                api.repositories[0].inputBox.value = commitMessage;
                                vscode.window.showInformationMessage("Commit message applied to Git input box.");
                                console.log("Applied commit message to Git input.");
                            } else {
                                await vscode.env.clipboard.writeText(commitMessage);
                                vscode.window.showWarningMessage("Commit message copied to clipboard (Git extension/repository not readily available).");
                                console.log("Copied commit message (Git API not found/ready).");
                            }
                        } else if (selection === "Copy to Clipboard") {
                            await vscode.env.clipboard.writeText(commitMessage);
                            vscode.window.showInformationMessage("Commit message copied to clipboard.");
                            console.log("Copied commit message to clipboard.");
                        } else {
                           console.log("User cancelled using generated message.");
                        }
                    } else {
                        // generateCommitMessage should throw an error if it fails,
                        // but handle the case where it might return empty/null unexpectedly
                        console.log("Generation resulted in empty message.");
                        vscode.window.showWarningMessage("Failed to generate commit message (empty response).");
                    }
                } // Progress scope ends
            ); // withProgress ends
        } catch (error: any) {
            console.error(`Error in generateCommitMessage command:`, error);
            vscode.window.showErrorMessage(`Error generating commit message: ${error.message}`);
        }
    } // Command handler ends
  ); // registerCommand ends

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
  console.log("Commands pushed.");

  console.log("ACTIVATE END");
} // activate function ends

// --- getStagedDiff Function ---
async function getStagedDiff(workspacePath: string): Promise<string> {
    console.log(`Executing 'git diff --cached' in ${workspacePath}`);
    return new Promise((resolve, reject) => {
        cp.exec("git diff --cached", { cwd: workspacePath, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Git diff error: ${error.message}`);
                console.error(`Git diff stderr: ${stderr}`);
                // Try to provide a more user-friendly error
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
async function generateCommitMessage(apiKey: string, prompt: string, diff: string): Promise<string> {
    console.log("Initializing Gemini AI client...");
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

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
                    case 'getInitialSettings': // Handle request from webview script
                         console.log("Webview requested initial settings. Posting current settings...");
                         this._updateWebviewSettings();
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
    private _updateWebviewSettings() {
        if (!this._view) {
            console.warn("Attempted to update webview settings, but view is not available.");
            return;
        }
        console.log("Fetching current config to send to webview...");
        const config = vscode.workspace.getConfiguration("gitDiffCommitGenerator");
        const apiKey = config.get<string>("apiKey");
        const prompt = config.get<string>("prompt") || getDefaultPrompt();

        console.log(`--> Posting 'updateSettings': hasApiKey=${!!apiKey}`); // Log before posting
        this._view.webview.postMessage({
            command: "updateSettings",
            hasApiKey: !!apiKey,
            prompt: prompt,
        }).then(
             (success) => { if (!success) console.warn("--> postMessage 'updateSettings' returned false."); }, // Log if postMessage fails
             (error) => { console.error("--> postMessage 'updateSettings' FAILED:", error); }
         );
    }

    // Generates the HTML content for the webview
    private _getHtmlForWebview(webview: vscode.Webview): string {
        console.log("Generating HTML content for webview...");
        // Get URIs for local resources
        // const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js')); // Example if using separate JS
        // const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'styles.css')); // Example if using separate CSS

        // Use a nonce for inline scripts/styles (more secure)
        const nonce = getNonce();

        // Note: Using inline styles/scripts for simplicity here, but external files are better practice
        const htmlContent = `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <!-- Set Content Security Policy -->
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
                    --button-padding: 8px 12px;
                    --section-padding: 15px;
                    --gap: 10px;
                }
                body {
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-sideBar-background); /* Match sidebar */
                    padding: var(--section-padding);
                    box-sizing: border-box;
                    height: 100vh;
                    display: flex;
                    flex-direction: column;
                }
                *, *::before, *::after {
                    box-sizing: inherit;
                }

                /* Layout */
                .container {
                    display: flex;
                    flex-direction: column;
                    gap: calc(var(--gap) * 1.5);
                    flex-grow: 1; /* Allow container to fill space */
                }
                .section {
                    background-color: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); /* Use widget background if available */
                    padding: var(--section-padding);
                    border-radius: 6px;
                    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
                }
                .action-container {
                    display: flex;
                    flex-direction: column;
                    gap: var(--gap);
                    margin-top: var(--gap);
                }

                /* Elements */
                h3 {
                    margin-top: 0;
                    margin-bottom: var(--gap);
                    font-size: 1.1em; /* Slightly larger */
                    font-weight: 600;
                    color: var(--vscode-sideBarTitle-foreground); /* Match title color */
                    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
                    padding-bottom: 5px;
                }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: 1px solid var(--vscode-button-border, transparent);
                    padding: var(--button-padding);
                    cursor: pointer;
                    border-radius: 4px;
                    font-weight: 500;
                    transition: background-color 0.2s ease-in-out, border-color 0.2s ease-in-out;
                    width: 100%;
                    text-align: center;
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                button:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                    outline-offset: 2px;
                }
                button:disabled {
                    background-color: var(--vscode-button-secondaryBackground, var(--vscode-disabledForeground));
                    color: var(--vscode-disabledForeground);
                    cursor: not-allowed;
                    opacity: 0.7;
                    border-color: transparent;
                }
                textarea {
                    width: 100%;
                    min-height: 100px; /* Adjust as needed */
                    max-height: 300px; /* Prevent excessive height */
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 4px;
                    padding: 8px;
                    font-family: var(--vscode-editor-font-family);
                    font-size: var(--vscode-editor-font-size);
                    resize: vertical; /* Allow vertical resize */
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
                    margin-bottom: var(--gap);
                    font-size: 0.9em;
                }
                .api-status-icon {
                    width: 10px;
                    height: 10px;
                    border-radius: 50%;
                    flex-shrink: 0; /* Prevent icon from shrinking */
                    border: 1px solid var(--vscode-contrastBorder, transparent);
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
            </style>
        </head>
        <body>
            <div class="container">
                <div class="section">
                    <h3>API Key</h3>
                    <div class="api-key-status">
                        <div id="apiKeyStatus" class="api-status-icon not-set"></div>
                        <span id="apiKeyStatusText">Checking...</span>
                    </div>
                    <div class="action-container" style="margin-top: 0;"> <!-- Reduced margin -->
                        <button id="setApiKeyBtn">Set/Update Gemini API Key</button>
                    </div>
                </div>

                <div class="section">
                    <h3>Generate</h3>
                    <div class="action-container">
                        <button id="generateBtn" disabled>Generate from Staged Changes</button>
                        <small id="generateStatus" style="color: var(--vscode-descriptionForeground); text-align: center;"></small>
                    </div>
                </div>

                <div class="section">
                    <h3>Prompt Template</h3>
                    <textarea id="promptTemplate" placeholder="Enter your custom prompt template... (Uses default if empty)"></textarea>
                    <div class="action-container">
                        <button id="savePromptBtn">Save Prompt Template</button>
                    </div>
                </div>
            </div>

            <script nonce="${nonce}">
                // Wrap in IIFE to avoid polluting global scope
                (function() {
                    // Check if acquireVsCodeApi exists (robustness)
                    if (typeof acquireVsCodeApi === 'function') {
                        const vscode = acquireVsCodeApi();

                        // --- Elements ---
                        const apiKeyStatusIcon = document.getElementById('apiKeyStatus');
                        const apiKeyStatusText = document.getElementById('apiKeyStatusText');
                        const setApiKeyBtn = document.getElementById('setApiKeyBtn');
                        const generateBtn = document.getElementById('generateBtn');
                        const promptTemplate = document.getElementById('promptTemplate');
                        const savePromptBtn = document.getElementById('savePromptBtn');
                        const generateStatus = document.getElementById('generateStatus'); // For feedback

                        // --- State ---
                        let currentApiKeySet = false;
                        // Store previous state to avoid unnecessary updates
                        const previousState = vscode.getState() || { hasApiKey: false, prompt: '' };
                        console.log('Initial webview state:', previousState);


                        // --- Functions ---
                        function updateApiKeyStatus(hasApiKey) {
                            currentApiKeySet = hasApiKey; // Update internal state tracker
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
                             promptTemplate.value = promptValue || ''; // Handle null/undefined
                        }

                        function saveState() {
                            vscode.setState({
                                hasApiKey: currentApiKeySet,
                                prompt: promptTemplate.value
                            });
                            console.log('Webview state saved.');
                        }

                        // --- Event listeners ---
                        setApiKeyBtn.addEventListener('click', () => {
                            console.log('Set API Key button clicked');
                            generateStatus.textContent = ''; // Clear status
                            vscode.postMessage({ command: 'setApiKey' });
                        });

                        generateBtn.addEventListener('click', () => {
                             console.log('Generate button clicked');
                             if (!generateBtn.disabled) {
                                generateStatus.textContent = 'Generating...'; // Provide feedback
                                vscode.postMessage({ command: 'generateCommitMessage' });
                             }
                        });

                        savePromptBtn.addEventListener('click', () => {
                            console.log('Save Prompt button clicked');
                            generateStatus.textContent = ''; // Clear status
                            vscode.postMessage({
                                command: 'setPrompt',
                                value: promptTemplate.value
                            });
                        });

                        // Save state when textarea loses focus (optional, good for persistence)
                        promptTemplate.addEventListener('blur', saveState);

                        // --- Handle messages from extension ---
                        window.addEventListener('message', event => {
                            const message = event.data; // The JSON data from the extension
                            console.log('Webview received command:', message.command);

                            switch (message.command) {
                                case 'updateSettings':
                                    console.log('Updating UI from received settings:', message);
                                    updateApiKeyStatus(message.hasApiKey);
                                    updatePrompt(message.prompt);
                                    generateStatus.textContent = ''; // Clear status on update
                                    // Save received state
                                    currentApiKeySet = message.hasApiKey;
                                    saveState();
                                    break;
                                // Add other message handlers if needed
                            }
                        });

                         // --- Initialization ---
                         console.log('Webview script initializing...');
                         // Restore state immediately
                         updateApiKeyStatus(previousState.hasApiKey);
                         updatePrompt(previousState.prompt);
                         // Request fresh state from the extension in case config changed while hidden
                         console.log('Requesting initial settings from extension...');
                         vscode.postMessage({ command: 'getInitialSettings' });


                    } else {
                        console.error("acquireVsCodeApi is not available. Webview cannot communicate with the extension.");
                        // Display error to user in the webview itself
                        document.body.innerHTML = '<div style="padding: 20px; color: var(--vscode-errorForeground);">Error: Cannot initialize communication with VS Code.</div>';
                    }
                }()); // End IIFE
            </script>
        </body>
        </html>`;
        console.log("-> HTML content generated.");
        return htmlContent;
    }
} // End class CommitMessageViewProvider

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