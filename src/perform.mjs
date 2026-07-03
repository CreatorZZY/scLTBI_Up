#!/bin/env zx
import fs from 'fs';
import path from 'path';
import { argv } from 'process';
import { fileURLToPath } from 'url';

// # ============================================================================
// # src/perform.mjs — Remote launcher for ln202 + sdsb container
// #
// # Usage:
// #   zx src/perform.mjs --init              # setup tmux session + sdsb on ln202
// #   zx src/perform.mjs <command...>        # run command in ln202 tmux session
// #   zx src/perform.mjs --sync <command...> # run & wait for completion (polling)
// #   zx src/perform.mjs --status            # check tmux session status
// # ============================================================================

process.env.FORCE_COLOR = '3';
chalk.level = 3;
$.shell = "/usr/bin/bash";
$.stdio = "inherit";
$.nothrow = true;

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_NAME = path.basename(PROJECT_ROOT);

// --- Config ---
const REMOTE_HOST = "ln202";
const TMUX_SESSION = PROJECT_NAME;
const TMUX_WINDOW = argv?.name ?? "main";          // window name inside tmux session
const SDSB_CMD = "sdsb";          // sdsb is on PATH via ~/.bashrc
const POLL_INTERVAL_MS = 5000;        // check completion every 5s
const SETUP_TIMEOUT_MS = 120_000;     // 2 min for sdsb SLURM allocation

// # ============================================================================
// # Parse args — zx's global `argv` is minimist-parsed in v7+
// # If unavailable (older zx), fall back to process.argv
// # ============================================================================

const hasArgv = typeof argv !== 'undefined' && argv && typeof argv._ === 'object';

const isInit = hasArgv ? (argv.init || argv.i || false) : process.argv.includes('--init');
const isSync = hasArgv ? (argv.sync || argv.s || false) : process.argv.includes('--sync');
const isStatus = hasArgv ? (argv.status || false) : process.argv.includes('--status');

const positional = hasArgv
    ? argv._
    : process.argv.slice(3).filter(a => !a.startsWith('--'));
const remoteCmd = positional.join(' ');

// # ============================================================================
// # Helpers: SSH to ln202
// # ============================================================================

function ssh(args, opts = {}) {
    const sshArgs = ['ssh', '-o', 'StrictHostKeyChecking=no', REMOTE_HOST, ...args];
    if (opts.quiet) {
        return $({ stdio: ["inherit", "pipe", "pipe"], quiet: true })`${sshArgs}`;
    }
    return $`${sshArgs}`;
}

async function sshCapture(cmd) {
    const proc = await $({ stdio: ["inherit", "pipe", "pipe"], quiet: true })`ssh -o StrictHostKeyChecking=no ${REMOTE_HOST} ${cmd}`;
    if (proc.exitCode !== 0) {
        throw new Error(`SSH command failed (exit ${proc.exitCode}): ${cmd}`);
    }
    return proc.stdout.trim();
}

// # ============================================================================
// # Tmux operations (executed remotely via SSH)
// # ============================================================================

async function tmuxHasSession() {
    try {
        await sshCapture(`tmux has-session -t ${TMUX_SESSION} 2>&1`);
        return true;
    } catch {
        return false; // session does not exist
    }
}

async function tmuxRun(rawKeys) {
    // Send keys to tmux window. $1 = tmux target, remaining = literal keys
    // Using `tmux send-keys -t <target> <keys> Enter`
    const escaped = rawKeys.replace(/'/g, `'\\''`); // escape single quotes for bash
    await sshCapture(`tmux send-keys -t ${TMUX_SESSION}:${TMUX_WINDOW} '${escaped}' Enter`);
}

async function tmuxCapturePane() {
    return await sshCapture(`tmux capture-pane -t ${TMUX_SESSION}:${TMUX_WINDOW} -p`);
}

// # ============================================================================
// # --init: Create tmux session + sdsb window on ln202
// # ============================================================================

async function doInit() {
    console.log(chalk.blueBright(`[init] Setting up tmux session "${TMUX_SESSION}" on ${REMOTE_HOST}...`));

    // Check if session already exists
    const exists = await tmuxHasSession();
    if (exists) {
        console.log(chalk.yellowBright(`[init] tmux session "${TMUX_SESSION}" already exists on ${REMOTE_HOST}.`));
        console.log(chalk.yellowBright(`[init] Attach with: ssh -t ${REMOTE_HOST} tmux attach -t ${TMUX_SESSION}`));
        return;
    }

    // Create detached tmux session:
    //   tmux new-session -d -s <name> -n <window> <command>
    // The command is `sdsb` which submits SLURM job, waits for allocation,
    // then drops into a Singularity container bash shell.
    console.log(chalk.blueBright(`[init] Creating tmux session with sdsb container...`));
    console.log(chalk.gray(`[init] This may take 1-2 minutes for SLURM allocation...`));

    await sshCapture(
        `tmux new-session -d -s ${TMUX_SESSION} -n ${TMUX_WINDOW} ` +
        `'${SDSB_CMD} bash -c "cd /mnt/pwd && exec bash"'`
    );

    // Wait for container shell to be ready (poll for a recognizable prompt)
    console.log(chalk.blueBright(`[init] Waiting for sdsb container to be ready...`));
    const startTime = Date.now();
    let ready = false;
    while (Date.now() - startTime < SETUP_TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        try {
            const pane = await tmuxCapturePane();
            // Container is ready if we see a bash prompt ($ or #) and not SLURM pending messages
            if (/[$#]\s*$/.test(pane) && !pane.includes('pending') && !pane.includes('queued')) {
                ready = true;
                break;
            }
        } catch {
            // tmux may not be ready yet
        }
    }

    if (!ready) {
        console.log(chalk.yellowBright(
            `[init] Timeout waiting for container prompt. ` +
            `Check manually: ssh -t ${REMOTE_HOST} tmux attach -t ${TMUX_SESSION}`
        ));
        return;
    }

    // Navigate to project directory
    await tmuxRun(`cd ${PROJECT_ROOT}`);
    await new Promise(r => setTimeout(r, 1000));

    console.log(chalk.greenBright(`[init] tmux session "${TMUX_SESSION}" is ready on ${REMOTE_HOST}!`));
    console.log(chalk.gray(`[init] Attach:  ssh -t ${REMOTE_HOST} tmux attach -t ${TMUX_SESSION}`));
    console.log(chalk.gray(`[init] Detach:  Ctrl+B D`));
    console.log(chalk.gray(`[init] Run:     zx src/perform.mjs <your command>`));
}

// # ============================================================================
// # --status: Check tmux session state
// # ============================================================================

async function doStatus() {
    const exists = await tmuxHasSession();
    if (exists) {
        const pane = await tmuxCapturePane();
        const lastLines = pane.split('\n').slice(-5).join('\n');
        console.log(chalk.greenBright(`[status] tmux session "${TMUX_SESSION}" EXISTS on ${REMOTE_HOST}`));
        console.log(chalk.gray(`[status] Last pane lines:\n${lastLines}`));
    } else {
        console.log(chalk.redBright(`[status] tmux session "${TMUX_SESSION}" NOT FOUND on ${REMOTE_HOST}`));
        console.log(chalk.gray(`[status] Run "zx src/perform.mjs --init" to create it.`));
    }
}

// # ============================================================================
// # Execute remote command
// # ============================================================================

async function doExec(cmd) {
    console.log(chalk.blueBright(`[exec] Sending to ${REMOTE_HOST} tmux ${TMUX_SESSION}:${TMUX_WINDOW}:`));
    console.log(chalk.cyan(`  ${cmd}`));

    // Verify tmux session exists
    const exists = await tmuxHasSession();
    if (!exists) {
        console.log(chalk.redBright(`[exec] tmux session "${TMUX_SESSION}" not found on ${REMOTE_HOST}.`));
        console.log(chalk.redBright(`[exec] Run "zx src/perform.mjs --init" first.`));
        process.exit(1);
    }

    // Navigate to project root first, then execute command
    const fullCmd = `cd ${PROJECT_ROOT} && ${cmd}`;
    await tmuxRun(fullCmd);

    console.log(chalk.greenBright(`[exec] Command sent to tmux window.`));
    console.log(chalk.gray(`[exec] Monitor: ssh -t ${REMOTE_HOST} tmux attach -t ${TMUX_SESSION}`));
}

// # ============================================================================
// # --sync: Execute and wait for completion (poll tmux pane for idle state)
// # ============================================================================

async function doSync(cmd) {
    await doExec(cmd);

    console.log(chalk.blueBright(`[sync] Waiting for command to finish (polling every ${POLL_INTERVAL_MS / 1000}s)...`));

    // Poll the tmux pane. We detect completion by:
    // 1. The pane content stops changing (idle detection)
    // 2. AND ends with a shell prompt ($ or #)
    let prevPane = '';
    let idleCount = 0;
    const IDLE_THRESHOLD = 3; // 3 consecutive unchanged polls = done

    while (true) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        let pane;
        try {
            pane = await tmuxCapturePane();
        } catch {
            console.log(chalk.redBright(`[sync] Lost connection to tmux session.`));
            process.exit(1);
        }

        if (pane === prevPane) {
            idleCount++;
            // Check if it looks like a finished command (prompt at end)
            if (idleCount >= IDLE_THRESHOLD && /[$#]\s*$/.test(pane.trim())) {
                console.log(chalk.greenBright(`[sync] Command appears to have completed.`));
                // Print last ~20 lines for context
                const lines = pane.split('\n');
                const tail = lines.slice(-20).join('\n');
                console.log(chalk.gray(`[sync] Last output:\n---\n${tail}\n---`));
                break;
            }
        } else {
            idleCount = 0;
            prevPane = pane;
            // Print progress dot every poll
            process.stdout.write(chalk.gray('.'));
        }
    }
}

// # ============================================================================
// # Main dispatch
// # ============================================================================

(async () => {
    if (isInit) {
        await doInit();
    } else if (isStatus) {
        await doStatus();
    } else if (isSync) {
        if (!remoteCmd) {
            console.error(chalk.redBright('Usage: zx src/perform.mjs --sync <command...>'));
            process.exit(1);
        }
        await doSync(remoteCmd);
    } else if (remoteCmd) {
        await doExec(remoteCmd);
    } else {
        console.log(chalk.blueBright('Usage:'));
        console.log(chalk.gray('  zx src/perform.mjs --init              # Setup tmux + sdsb on ln202'));
        console.log(chalk.gray('  zx src/perform.mjs --status            # Check session status'));
        console.log(chalk.gray('  zx src/perform.mjs <command...>        # Fire-and-forget command'));
        console.log(chalk.gray('  zx src/perform.mjs --sync <command...> # Run and wait for completion'));
        console.log(chalk.blueBright('\nExamples:'));
        console.log(chalk.gray('  zx src/perform.mjs zx src/cellranger_count.mjs'));
        console.log(chalk.gray('  zx src/perform.mjs --sync zx src/cellranger_count.mjs'));
        console.log(chalk.gray('  zx src/perform.mjs ls -la data/geo/PRJNA605083/'));
    }
})();
