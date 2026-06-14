'use strict';

const vscode = require('vscode');
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

let out;

function activate(context) {
    out = vscode.window.createOutputChannel('lkrag');
    context.subscriptions.push(
        out,
        vscode.commands.registerCommand('lkrag.search', runSearch)
    );
}

function getLkragPath() {
    const config = vscode.workspace.getConfiguration('lkrag');
    const explicit = config.get('executablePath', '').trim();
    if (explicit) return explicit;
    const candidates = [
        path.join(os.homedir(), '.npm-global', 'bin', 'lkrag'),
        path.join(os.homedir(), '.local', 'share', 'npm', 'bin', 'lkrag'),
        '/usr/local/bin/lkrag',
        '/usr/bin/lkrag',
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return 'lkrag'; // rely on PATH
}

function runSearch() {
    const config = vscode.workspace.getConfiguration('lkrag');
    const explicitWorkspace = config.get('workspacePath', '').trim();
    const limit = config.get('limit', 20);
    const lkrag = getLkragPath();

    const qp = vscode.window.createQuickPick();
    qp.placeholder = 'Search local knowledge index...';
    qp.matchOnDescription = false;
    qp.matchOnDetail = false;

    let debounceTimer = null;
    let resolvedWorkspace = explicitWorkspace || null;
    let lastQuery = '';
    let ignoreChange = false;

    qp.onDidChangeValue(value => {
        if (ignoreChange) {
            if (value === '') return; // programmatic clear — skip
            ignoreChange = false;    // user started typing a new query
        }
        if (debounceTimer) clearTimeout(debounceTimer);
        if (!value.trim()) {
            qp.items = [];
            qp.busy = false;
            return;
        }
        qp.busy = true;
        lastQuery = value.trim();
        debounceTimer = setTimeout(() => {
            search(lkrag, lastQuery, explicitWorkspace, limit, (items, ws) => {
                if (ws) resolvedWorkspace = ws;
                const fromStr = resolvedWorkspace ? `  —  ${resolvedWorkspace}` : '';
                // Set ignoreChange before clearing value so the resulting
                // onDidChangeValue('') event is suppressed regardless of timing.
                ignoreChange = true;
                qp.value = '';
                qp.title = `"${lastQuery}"${fromStr}`;
                qp.placeholder = 'Type to search again...';
                qp.items = items;
                qp.busy = false;
            });
        }, 300);
    });

    qp.onDidChangeActive(items => {
        const item = items[0];
        if (item && item.filePath) {
            previewFile(item.filePath, item.lineNo);
        }
    });

    qp.onDidAccept(() => {
        const item = qp.activeItems[0];
        out.appendLine(`[lkrag] accept: label=${item?.label} filePath=${item?.filePath} lineNo=${item?.lineNo}`);
        if (item && item.filePath) {
            qp.hide();
            openFile(item.filePath, item.lineNo);
        }
    });

    qp.show();
}

function search(lkrag, query, workspacePath, limit, callback) {
    const args = ['search', query, '--format', 'tsv', '--limit', String(limit)];
    if (workspacePath) {
        args.push('--quiet', '--workspace-path', workspacePath);
    } else {
        args.push('--find-workspace');
    }

    // Use the first VS Code workspace folder as cwd so --find-workspace
    // traverses from the project root, not the extension host directory.
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

    out.appendLine(`[lkrag] exec: ${lkrag} ${args.join(' ')}`);
    out.appendLine(`[lkrag] cwd:  ${cwd}`);

    execFile(lkrag, args, { cwd }, (err, stdout, stderr) => {
        if (stderr) out.appendLine(`[lkrag] stderr: ${stderr.trim()}`);
        if (err)    out.appendLine(`[lkrag] error:  ${err.message} (code=${err.code})`);
        if (stdout) out.appendLine(`[lkrag] stdout: ${stdout.substring(0, 200)}`);

        if (err && !stdout) {
            if (err.code === 'ENOENT') {
                vscode.window.showErrorMessage(
                    'lkrag not found. Set lkrag.executablePath in settings or ensure lkrag is in PATH.'
                );
            } else {
                vscode.window.showErrorMessage(
                    `lkrag error: ${stderr.trim() || err.message}`
                );
            }
            callback([], null);
            return;
        }

        let resolvedWs = null;
        const wsMatch = stderr.match(/^\[lkrag\] workspace: (.+)/m);
        if (wsMatch) resolvedWs = wsMatch[1].trim();

        const items = stdout
            .split('\n')
            .filter(l => l.includes('\t'))
            .map(line => {
                const parts = line.split('\t');
                const rawPath = parts[0];
                const lineNo = parseInt(parts[1], 10) || 1;
                const score = parts[2] || '';
                const content = (parts[3] || '').trim();
                // lkrag TSV outputs paths relative to the workspace root.
                // Resolve to absolute so vscode.Uri.file() works correctly.
                const filePath = resolvedWs
                    ? path.resolve(resolvedWs, rawPath)
                    : path.resolve(cwd, rawPath);
                const relPath = resolvedWs
                    ? path.relative(resolvedWs, filePath)
                    : rawPath;
                return {
                    label: relPath,
                    description: `line ${lineNo}  [${score}]`,
                    detail: content.substring(0, 120),
                    filePath,
                    lineNo,
                };
            });

        out.appendLine(`[lkrag] ${items.length} result(s)`);
        callback(items, resolvedWs);
    });
}

async function previewFile(filePath, lineNo) {
    try {
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const selection = new vscode.Range(lineNo - 1, 0, lineNo - 1, 0);
        await vscode.window.showTextDocument(doc, {
            preview: true,
            preserveFocus: true,
            viewColumn: vscode.ViewColumn.Active,
            selection,
        });
    } catch (_) {}
}

async function openFile(filePath, lineNo) {
    try {
        out.appendLine(`[lkrag] openFile: ${filePath}:${lineNo}`);
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const selection = new vscode.Range(lineNo - 1, 0, lineNo - 1, 0);
        await vscode.window.showTextDocument(doc, {
            preview: false,
            selection,
        });
    } catch (e) {
        out.appendLine(`[lkrag] openFile error: ${e.message}`);
        vscode.window.showErrorMessage(`lkrag: cannot open file: ${e.message}`);
    }
}

function deactivate() {}

module.exports = { activate, deactivate };
