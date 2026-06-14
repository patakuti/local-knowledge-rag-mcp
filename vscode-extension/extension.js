'use strict';

const vscode = require('vscode');
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

function activate(context) {
    context.subscriptions.push(
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
    qp.matchOnDetail = true;

    let debounceTimer = null;
    let resolvedWorkspace = explicitWorkspace || null;

    qp.onDidChangeValue(value => {
        if (debounceTimer) clearTimeout(debounceTimer);
        if (!value.trim()) {
            qp.items = [];
            qp.busy = false;
            return;
        }
        qp.busy = true;
        debounceTimer = setTimeout(() => {
            search(lkrag, value.trim(), explicitWorkspace, limit, (items, ws) => {
                if (ws) resolvedWorkspace = ws;
                qp.title = resolvedWorkspace ? `From: ${resolvedWorkspace}` : undefined;
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
        const item = qp.selectedItems[0];
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

    execFile(lkrag, args, (err, stdout, stderr) => {
        if (err && !stdout) {
            if (err.code === 'ENOENT') {
                vscode.window.showErrorMessage(
                    'lkrag not found. Set lkrag.executablePath in settings or ensure lkrag is in PATH.'
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
                const filePath = parts[0];
                const lineNo = parseInt(parts[1], 10) || 1;
                const score = parts[2] || '';
                const content = (parts[3] || '').trim();
                const relPath = resolvedWs
                    ? path.relative(resolvedWs, filePath)
                    : filePath;
                return {
                    label: relPath,
                    description: `line ${lineNo}  [${score}]`,
                    detail: content.substring(0, 120),
                    filePath,
                    lineNo,
                };
            });

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
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const selection = new vscode.Range(lineNo - 1, 0, lineNo - 1, 0);
        await vscode.window.showTextDocument(doc, {
            preview: false,
            selection,
        });
    } catch (_) {}
}

function deactivate() {}

module.exports = { activate, deactivate };
