// We keep all state in one object so it is easy to inspect while learning.
const appState = {
  rows: 12,
  cols: 12,
  isRunning: false,
  grid: [],
  generation: 0,
  stepIntervalMs: 300,
  audioContext: null,
  masterGain: null,
  timerWorker: null,
};

// We map the automaton into a minor pentatonic palette.
// This keeps the output cohesive even as the visual state becomes complex.
const SCALE_INTERVALS = [0, 3, 5, 7, 10];
const BASE_MIDI_NOTE = 48;

// Grab the page elements once at startup so the rest of the code can reuse them.
const canvas = document.getElementById("automata-canvas");
const context = canvas.getContext("2d");
const rowsInput = document.getElementById("rows-input");
const colsInput = document.getElementById("cols-input");
const speedInput = document.getElementById("speed-input");
const randomizeButton = document.getElementById("randomize-button");
const clearButton = document.getElementById("clear-button");
const stepButton = document.getElementById("step-button");
const runButton = document.getElementById("run-button");
const statusText = document.getElementById("status-text");
const generationValue = document.getElementById("generation-value");
const aliveValue = document.getElementById("alive-value");

// A cellular automaton stores its state in a 2D grid.
// Each cell is either alive (1) or dead (0).
function createEmptyGrid(rows, cols) {
  return Array.from({ length: rows }, () => Array(cols).fill(0));
}

// This creates a starting pattern for the automaton.
// We use a random choice so the grid begins with a mix of alive and dead cells.
function createRandomGrid(rows, cols) {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => (Math.random() < 0.35 ? 1 : 0))
  );
}

// Keep the row and column values in appState synchronized with the form inputs.
function syncDimensionsFromInputs() {
  appState.rows = Number(rowsInput.value);
  appState.cols = Number(colsInput.value);
}

// This helper counts how many cells are currently alive in the whole grid.
// It is not required for the automaton rules, but it gives us useful feedback.
function countAliveCells(grid) {
  return grid.flat().reduce((total, cell) => total + cell, 0);
}

// Keep the mini dashboard in sync with the current simulation state.
function updateStats() {
  generationValue.textContent = String(appState.generation);
  aliveValue.textContent = String(countAliveCells(appState.grid));
}

// The slider is inverted so moving right means faster playback.
function getStepIntervalFromSlider() {
  const min = Number(speedInput.min);
  const max = Number(speedInput.max);
  const sliderValue = Number(speedInput.value);

  return max + min - sliderValue;
}

// Many browsers heavily throttle main-thread timers when a tab is hidden.
// A tiny Worker-based timer is more reliable for background playback.
function ensureTimerWorker() {
  if (appState.timerWorker !== null) {
    return;
  }

  const workerSource = `
    let intervalId = null;

    self.onmessage = (event) => {
      const { type, intervalMs } = event.data;

      if (type === "start") {
        if (intervalId !== null) {
          clearInterval(intervalId);
        }

        intervalId = setInterval(() => {
          self.postMessage({ type: "tick" });
        }, intervalMs);
      }

      if (type === "stop" && intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
  `;

  const workerBlob = new Blob([workerSource], {
    type: "application/javascript",
  });
  const workerUrl = URL.createObjectURL(workerBlob);

  appState.timerWorker = new Worker(workerUrl);
  URL.revokeObjectURL(workerUrl);

  appState.timerWorker.addEventListener("message", (event) => {
    if (event.data.type === "tick" && appState.isRunning) {
      stepAutomaton();
    }
  });
}

// Convert a MIDI note number into a frequency in hertz.
function midiToFrequency(midiNote) {
  return 440 * 2 ** ((midiNote - 69) / 12);
}

// This translates a vertical position into a note choice.
// The top of the grid becomes higher notes and the bottom becomes lower notes.
function getMidiNoteForVerticalPosition(rowPosition) {
  const pitchIndex = Math.round(appState.rows - 1 - rowPosition);
  const scaleDegree = pitchIndex % SCALE_INTERVALS.length;
  const octave = Math.floor(pitchIndex / SCALE_INTERVALS.length);

  return BASE_MIDI_NOTE + SCALE_INTERVALS[scaleDegree] + octave * 12;
}

// Browsers only allow audio to begin after user interaction.
// We create one shared AudioContext and one master volume control.
function ensureAudio() {
  if (appState.audioContext === null) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      statusText.textContent =
        "This browser does not support the Web Audio API.";
      return;
    }

    appState.audioContext = new AudioContextClass();
    appState.masterGain = appState.audioContext.createGain();
    appState.masterGain.gain.value = 0.58;
    appState.masterGain.connect(appState.audioContext.destination);
  }

  if (appState.audioContext.state === "suspended") {
    appState.audioContext.resume().catch(() => {
      statusText.textContent =
        "Click Start or Step Once again if the browser blocked audio.";
    });
  }
}

// Play one soft synth pad note.
// We layer smoother oscillators, use a slower filter sweep, and stretch the
// envelope so the note blooms instead of hitting like a lead sound.
function playNote(frequency, volume, duration, startOffset = 0) {
  if (appState.audioContext === null || appState.masterGain === null) {
    return;
  }

  const filter = appState.audioContext.createBiquadFilter();
  const voiceGain = appState.audioContext.createGain();
  const now = appState.audioContext.currentTime;
  const startTime = now + startOffset;
  const peakTime = startTime + 0.16;
  const settleTime = startTime + 0.34;
  const endTime = startTime + duration;

  filter.type = "lowpass";
  filter.Q.setValueAtTime(4.5, startTime);
  filter.frequency.setValueAtTime(320, startTime);
  filter.frequency.exponentialRampToValueAtTime(1400, startTime + 0.24);
  filter.frequency.exponentialRampToValueAtTime(420, endTime);

  voiceGain.gain.setValueAtTime(0.0001, startTime);
  voiceGain.gain.linearRampToValueAtTime(volume, peakTime);
  voiceGain.gain.linearRampToValueAtTime(volume * 0.72, settleTime);
  voiceGain.gain.exponentialRampToValueAtTime(0.0001, endTime);

  const oscillatorSettings = [
    { type: "triangle", frequency, detune: -7, level: 0.24 },
    { type: "triangle", frequency, detune: 7, level: 0.24 },
    { type: "sine", frequency: frequency / 2, detune: 0, level: 0.18 },
  ];

  oscillatorSettings.forEach((settings) => {
    const oscillator = appState.audioContext.createOscillator();
    const oscillatorGain = appState.audioContext.createGain();

    oscillator.type = settings.type;
    oscillator.frequency.setValueAtTime(settings.frequency, startTime);
    oscillator.detune.setValueAtTime(settings.detune, startTime);
    oscillatorGain.gain.setValueAtTime(settings.level, startTime);

    oscillator.connect(oscillatorGain);
    oscillatorGain.connect(filter);
    oscillator.start(startTime);
    oscillator.stop(endTime + 0.04);
  });

  filter.connect(voiceGain);
  voiceGain.connect(appState.masterGain);
}

function getClustersSortedByImportance(analysis) {
  return [...analysis.clusters].sort((firstCluster, secondCluster) => {
    if (secondCluster.size !== firstCluster.size) {
      return secondCluster.size - firstCluster.size;
    }

    return firstCluster.centroidCol - secondCluster.centroidCol;
  });
}

function playLargestClusterMode(analysis) {
  const leadCluster = getClustersSortedByImportance(analysis)[0];

  if (!leadCluster) {
    return 0;
  }

  const clusterWeight = leadCluster.size / analysis.largestCluster;
  const midiNote = getMidiNoteForVerticalPosition(leadCluster.centroidRow);
  const frequency = midiToFrequency(midiNote);
  const volume = 0.1 + clusterWeight * 0.05;
  const duration = 0.78 + clusterWeight * 0.42;

  playNote(frequency, volume, duration);
  return 1;
}

// The final mapping uses the largest connected cluster as a single lead note.
function playGridAsMusic(analysis = analyzeLiveClusters()) {
  ensureAudio();

  if (
    appState.audioContext === null ||
    appState.audioContext.state !== "running"
  ) {
    return 0;
  }

  return playLargestClusterMode(analysis);
}

// Find connected groups of live cells so we can shade larger clusters darker.
// We use 8-direction connectivity so diagonally touching blocks count together.
function analyzeLiveClusters() {
  const clusterSizes = createEmptyGrid(appState.rows, appState.cols);
  const visited = Array.from({ length: appState.rows }, () =>
    Array(appState.cols).fill(false)
  );
  const clusters = [];
  let largestCluster = 1;

  for (let row = 0; row < appState.rows; row += 1) {
    for (let col = 0; col < appState.cols; col += 1) {
      if (appState.grid[row][col] === 0 || visited[row][col]) {
        continue;
      }

      const stack = [[row, col]];
      const clusterCells = [];

      visited[row][col] = true;

      while (stack.length > 0) {
        const [currentRow, currentCol] = stack.pop();
        clusterCells.push([currentRow, currentCol]);

        for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
          for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
            if (rowOffset === 0 && colOffset === 0) {
              continue;
            }

            const neighborRow = currentRow + rowOffset;
            const neighborCol = currentCol + colOffset;

            if (
              neighborRow < 0 ||
              neighborRow >= appState.rows ||
              neighborCol < 0 ||
              neighborCol >= appState.cols ||
              visited[neighborRow][neighborCol] ||
              appState.grid[neighborRow][neighborCol] === 0
            ) {
              continue;
            }

            visited[neighborRow][neighborCol] = true;
            stack.push([neighborRow, neighborCol]);
          }
        }
      }

      const clusterSize = clusterCells.length;
      largestCluster = Math.max(largestCluster, clusterSize);

      const centroid = clusterCells.reduce(
        (totals, [clusterRow, clusterCol]) => ({
          row: totals.row + clusterRow,
          col: totals.col + clusterCol,
        }),
        { row: 0, col: 0 }
      );

      clusters.push({
        size: clusterSize,
        centroidRow: centroid.row / clusterSize,
        centroidCol: centroid.col / clusterSize,
      });

      for (const [clusterRow, clusterCol] of clusterCells) {
        clusterSizes[clusterRow][clusterCol] = clusterSize;
      }
    }
  }

  return {
    clusterSizes,
    clusters,
    largestCluster,
  };
}

// Larger clusters become darker, which makes bigger structures stand out.
function getLiveCellColor(clusterSize, largestCluster) {
  const intensity = clusterSize / largestCluster;
  const hue = 215 - intensity * 215;
  const lightness = 58 - intensity * 16;
  const saturation = 88 - intensity * 8;

  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

// Draw the current state of the automaton.
// Alive cells use a darker color, dead cells use a light color.
function drawGrid(analysis = analyzeLiveClusters()) {
  const { rows, cols, grid } = appState;
  const cellWidth = canvas.width / cols;
  const cellHeight = canvas.height / rows;
  const { clusterSizes, largestCluster } = analysis;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#081226";
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (grid[row][col] === 1) {
        context.fillStyle = getLiveCellColor(
          clusterSizes[row][col],
          largestCluster
        );
      } else {
        context.fillStyle = "#0b1a34";
      }

      context.fillRect(col * cellWidth, row * cellHeight, cellWidth, cellHeight);

      context.strokeStyle = "rgba(102, 187, 255, 0.24)";
      context.strokeRect(col * cellWidth, row * cellHeight, cellWidth, cellHeight);
    }
  }
}

// Count the living neighbors around one cell.
// We use fixed edges, which means cells outside the grid are treated as dead.
function countLivingNeighbors(row, col) {
  let livingNeighbors = 0;

  for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
    for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
      if (rowOffset === 0 && colOffset === 0) {
        continue;
      }

      const neighborRow = row + rowOffset;
      const neighborCol = col + colOffset;

      if (
        neighborRow < 0 ||
        neighborRow >= appState.rows ||
        neighborCol < 0 ||
        neighborCol >= appState.cols
      ) {
        continue;
      }

      livingNeighbors += appState.grid[neighborRow][neighborCol];
    }
  }

  return livingNeighbors;
}

// Build the next generation of the grid using Conway's Game of Life rules:
// 1. A live cell survives with 2 or 3 live neighbors.
// 2. A dead cell becomes alive with exactly 3 live neighbors.
// 3. All other cells become or remain dead.
function computeNextGrid() {
  const nextGrid = createEmptyGrid(appState.rows, appState.cols);

  for (let row = 0; row < appState.rows; row += 1) {
    for (let col = 0; col < appState.cols; col += 1) {
      const currentCell = appState.grid[row][col];
      const livingNeighbors = countLivingNeighbors(row, col);

      if (currentCell === 1 && (livingNeighbors === 2 || livingNeighbors === 3)) {
        nextGrid[row][col] = 1;
      } else if (currentCell === 0 && livingNeighbors === 3) {
        nextGrid[row][col] = 1;
      } else {
        nextGrid[row][col] = 0;
      }
    }
  }

  return nextGrid;
}

// Advance the automaton by one generation.
function stepAutomaton() {
  appState.grid = computeNextGrid();
  appState.generation += 1;
  const clusterAnalysis = analyzeLiveClusters();

  // Hidden tabs do not need repeated canvas draws, but the automaton
  // and the music should continue evolving in the background.
  if (!document.hidden) {
    drawGrid(clusterAnalysis);
  }

  const aliveCount = countAliveCells(appState.grid);
  playGridAsMusic(clusterAnalysis);
  updateStats();
  statusText.textContent =
    `Generation ${appState.generation}: ${aliveCount} live cells.`;
}

function stopSimulation() {
  if (appState.timerWorker !== null) {
    appState.timerWorker.postMessage({ type: "stop" });
  }

  appState.isRunning = false;
  runButton.textContent = "Start";
}

function startSimulation() {
  if (appState.isRunning) {
    return;
  }

  ensureAudio();
  ensureTimerWorker();
  appState.isRunning = true;
  runButton.textContent = "Stop";
  appState.timerWorker.postMessage({
    type: "start",
    intervalMs: appState.stepIntervalMs,
  });

  const aliveCount = countAliveCells(appState.grid);
  updateStats();
  statusText.textContent =
    `Running from generation ${appState.generation} with ${aliveCount} live cells.`;
}

// When the user changes the grid size, we build a brand-new random grid
// with the new dimensions.
function rebuildGrid() {
  stopSimulation();
  syncDimensionsFromInputs();
  appState.grid = createRandomGrid(appState.rows, appState.cols);
  appState.generation = 0;
  drawGrid();

  const aliveCount = countAliveCells(appState.grid);
  updateStats();
  statusText.textContent =
    `Built a ${appState.rows} by ${appState.cols} grid with ${aliveCount} live cells.`;
}

// The randomize button gives us a fresh starting pattern without changing size.
function randomizeGrid() {
  stopSimulation();
  appState.grid = createRandomGrid(appState.rows, appState.cols);
  appState.generation = 0;
  drawGrid();

  const aliveCount = countAliveCells(appState.grid);
  updateStats();
  statusText.textContent =
    `Randomized generation 0 with ${aliveCount} live cells.`;
}

// Clearing the grid is helpful when you want to draw a pattern by hand.
function clearGrid() {
  stopSimulation();
  appState.grid = createEmptyGrid(appState.rows, appState.cols);
  appState.generation = 0;
  drawGrid();
  updateStats();
  statusText.textContent =
    "Cleared the grid. Click cells to build your own starting pattern.";
}

// Clicking a cell toggles it between alive and dead.
// This is useful for testing because you can build a pattern by hand.
function toggleCell(event) {
  const bounds = canvas.getBoundingClientRect();
  const scaleX = canvas.width / bounds.width;
  const scaleY = canvas.height / bounds.height;
  const mouseX = (event.clientX - bounds.left) * scaleX;
  const mouseY = (event.clientY - bounds.top) * scaleY;
  const cellWidth = canvas.width / appState.cols;
  const cellHeight = canvas.height / appState.rows;
  const col = Math.floor(mouseX / cellWidth);
  const row = Math.floor(mouseY / cellHeight);

  if (
    row < 0 ||
    row >= appState.rows ||
    col < 0 ||
    col >= appState.cols
  ) {
    return;
  }

  appState.grid[row][col] = appState.grid[row][col] === 1 ? 0 : 1;
  drawGrid();

  const aliveCount = countAliveCells(appState.grid);
  updateStats();
  statusText.textContent =
    `Toggled cell at row ${row}, column ${col}. ${aliveCount} live cells total.`;
}

// If the speed changes while the simulation is running, restart the timer
// so the new interval takes effect immediately.
function handleSpeedChange() {
  appState.stepIntervalMs = getStepIntervalFromSlider();

  if (!appState.isRunning) {
    statusText.textContent = "Speed updated.";
    return;
  }

  stopSimulation();
  startSimulation();
  statusText.textContent = "Speed updated.";
}

rowsInput.addEventListener("input", rebuildGrid);
colsInput.addEventListener("input", rebuildGrid);
speedInput.addEventListener("input", handleSpeedChange);
randomizeButton.addEventListener("click", randomizeGrid);
clearButton.addEventListener("click", clearGrid);
stepButton.addEventListener("click", stepAutomaton);
runButton.addEventListener("click", () => {
  if (appState.isRunning) {
    stopSimulation();
    const aliveCount = countAliveCells(appState.grid);
    updateStats();
    statusText.textContent =
      `Paused at generation ${appState.generation} with ${aliveCount} live cells.`;
  } else {
    startSimulation();
  }
});
canvas.addEventListener("click", toggleCell);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    drawGrid();
    updateStats();
  }
});

// Start with a random grid so the user immediately sees real automata state.
appState.stepIntervalMs = getStepIntervalFromSlider();
appState.grid = createEmptyGrid(appState.rows, appState.cols);
randomizeGrid();
