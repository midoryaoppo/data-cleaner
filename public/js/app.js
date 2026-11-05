(function () {
  'use strict';

  var MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  var WORKSPACE_KEY = 'tidydata:workspace:v1';
  var PENDING_KEY = 'tidydata:pending-action:v1';
  var DEFAULT_BILLING = {
    sandboxEnabled: false,
    stripeConfigured: false,
    stripeMode: 'disabled',
    highVolumeRowLimit: 5000,
    freeTier: {
      maxRows: 500,
      maxFileSizeBytes: 1024 * 1024,
      maxFileSizeMb: 1,
    },
    premiumExportFormats: ['ndjson', 'tsv'],
    bulkMaxFiles: 10,
    prices: {
      single: { amountCents: 500, display: '$5' },
      monthly: { amountCents: 1900, display: '$19' },
    },
    entitlement: null,
    premium: false,
  };
  var DEFAULT_OPTIONS = {
    removeDuplicates: true,
    removeEmptyRows: true,
    dropEmptyColumns: true,
    normalizeHeaders: true,
    trimWhitespace: true,
    normalizeNumbers: true,
    normalizeBooleans: true,
    normalizeDates: true,
    emptyToNull: true,
  };

  var state = {
    file: null,
    cleaned: null,
    busy: false,
    loadingSample: false,
    activeTab: 'original',
    billing: DEFAULT_BILLING,
    billingReady: false,
    checkoutPlan: 'single',
    checkoutBusy: false,
    sandboxTouched: false,
    checkoutTrigger: null,
    checkoutReason: null,
    checkoutFormat: null,
    paywallReason: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  var dom = {
    themeToggle: $('theme-toggle'),
    toastStack: $('toast-stack'),
    year: $('year'),
    workspace: $('workspace'),
    uploadPanel: $('upload-panel'),
    dropzone: $('dropzone'),
    dropIdle: $('drop-idle'),
    dropBusy: $('drop-busy'),
    fileInput: $('file-input'),
    sampleBtn: $('sample-btn'),
    replaceBtn: $('replace-btn'),
    editor: $('editor'),
    fileName: $('file-name'),
    fileFormat: $('file-format'),
    fileRows: $('file-rows'),
    fileCols: $('file-cols'),
    fileSize: $('file-size'),
    dedupeControls: $('dedupe-controls'),
    dedupeColumn: $('dedupe-column'),
    resetOptions: $('reset-options'),
    cleanBtn: $('clean-btn'),
    cleanBtnSpinner: $('clean-btn-spinner'),
    cleanBtnIcon: $('clean-btn-icon'),
    cleanBtnLabel: $('clean-btn-label'),
    cleanBtnArrow: $('clean-btn-arrow'),
    results: $('results'),
    resultsSubtitle: $('results-subtitle'),
    staleNote: $('stale-note'),
    statRows: $('stat-rows'),
    statRowsSub: $('stat-rows-sub'),
    statDupes: $('stat-dupes'),
    statDupesSub: $('stat-dupes-sub'),
    statEmpty: $('stat-empty'),
    statEmptySub: $('stat-empty-sub'),
    statCells: $('stat-cells'),
    statCellsSub: $('stat-cells-sub'),
    cleanedNote: $('cleaned-note'),
    warningsNote: $('warnings-note'),
    downloadCsv: $('download-csv'),
    downloadJson: $('download-json'),
    downloadNdjson: $('download-ndjson'),
    downloadTsv: $('download-tsv'),
    previewSection: $('preview-section'),
    previewLoading: $('preview-loading'),
    previewLoadingText: $('preview-loading-text'),
    previewThead: $('preview-thead'),
    previewTbody: $('preview-tbody'),
    previewMeta: $('preview-meta'),
    previewCols: $('preview-cols'),
    previewCountBadge: $('preview-count-badge'),
    tabOriginal: $('tab-original'),
    tabCleaned: $('tab-cleaned'),
    planBadge: $('plan-badge'),
    paywallNote: $('paywall-note'),
    paywallTitle: $('paywall-title'),
    paywallCopy: $('paywall-copy'),
    paywallPrice: $('paywall-price'),
    freeLimitNote: $('free-limit-note'),
    freeLimitCopy: $('free-limit-copy'),
    freeLimitUpgrade: $('free-limit-upgrade'),
    freeLimitPrice: $('free-limit-price'),
    unlockBtn: $('unlock-btn'),
    pricingSinglePrice: $('pricing-single-price'),
    pricingMonthlyPrice: $('pricing-monthly-price'),
    pricingFreeLimit: $('pricing-free-limit'),
    pricingFreeSize: $('pricing-free-size'),
    pricingModeNote: $('pricing-mode-note'),
    pricingModeText: $('pricing-mode-text'),
    checkoutModal: $('checkout-modal'),
    checkoutClose: $('checkout-close'),
    checkoutError: $('checkout-error'),
    checkoutEntitlement: $('checkout-entitlement'),
    checkoutSandboxRow: $('checkout-sandbox-row'),
    sandboxToggle: $('sandbox-toggle'),
    checkoutModeText: $('checkout-mode-text'),
    checkoutSubmit: $('checkout-submit'),
    checkoutSubmitSpinner: $('checkout-submit-spinner'),
    checkoutSubmitLabel: $('checkout-submit-label'),
    checkoutSubmitArrow: $('checkout-submit-arrow'),
    checkoutTotal: $('checkout-total'),
    checkoutRecurringNote: $('checkout-recurring-note'),
    checkoutLegalNote: $('checkout-legal-note'),
    checkoutSinglePrice: $('checkout-single-price'),
    checkoutMonthlyPrice: $('checkout-monthly-price'),
    checkoutFreeRows: $('checkout-free-rows'),
    checkoutFreeSize: $('checkout-free-size'),
  };

  var optionInputs = Array.prototype.slice.call(document.querySelectorAll('[data-option]'));
  var numberFormat = new Intl.NumberFormat();

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */

  function formatNumber(value) {
    return numberFormat.format(Number(value) || 0);
  }

  function plural(count, singular, pluralForm) {
    return formatNumber(count) + ' ' + (count === 1 ? singular : pluralForm);
  }

  function formatBytes(bytes) {
    var value = Number(bytes) || 0;
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10 * 1024 ? 1 : 0) + ' KB';
    return (value / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatLabel(file) {
    var extension = String(file.name || '')
      .split('.')
      .pop()
      .toLowerCase();
    if (extension === 'tsv') return 'TSV';
    if (extension === 'ndjson' || extension === 'jsonl') return 'NDJSON';
    if (file.format === 'json') return 'JSON';
    return 'CSV';
  }

  function baseName(name) {
    return String(name || 'data').replace(/\.[^./\\]+$/, '') || 'data';
  }

  function friendlyError(error) {
    if (error && error.name === 'TypeError' && /fetch|network/i.test(error.message || '')) {
      return 'Could not reach the server. Check that TidyData is running and try again.';
    }
    return (error && error.message) || 'Something unexpected happened. Please try again.';
  }

  function setStep(step) {
    var order = ['upload', 'clean', 'download'];
    var activeIndex = order.indexOf(step);
    document.querySelectorAll('[data-step]').forEach(function (item) {
      var index = order.indexOf(item.getAttribute('data-step'));
      item.classList.toggle('is-active', index === activeIndex);
      item.classList.toggle('is-complete', index < activeIndex);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Theme                                                               */
  /* ------------------------------------------------------------------ */

  function initTheme() {
    var root = document.documentElement;

    function syncLabel() {
      var isDark = root.classList.contains('dark');
      dom.themeToggle.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
      dom.themeToggle.title = isDark ? 'Switch to light theme' : 'Switch to dark theme';
    }

    dom.themeToggle.addEventListener('click', function () {
      var isDark = root.classList.toggle('dark');
      root.dataset.theme = isDark ? 'dark' : 'light';
      try {
        localStorage.setItem('tidydata-theme', isDark ? 'dark' : 'light');
      } catch (error) {
        /* Preference persistence is optional. */
      }
      syncLabel();
    });

    syncLabel();
  }

  /* ------------------------------------------------------------------ */
  /* Toasts                                                              */
  /* ------------------------------------------------------------------ */

  var TOAST_ICONS = {
    success: 'i-check-circle',
    error: 'i-alert',
    info: 'i-info',
  };

  function showToast(type, title, message) {
    var tone = Object.prototype.hasOwnProperty.call(TOAST_ICONS, type) ? type : 'info';
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + tone + ' animate-toast-in transition duration-200';
    toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    toast.innerHTML =
      '<span class="toast-icon">' +
      '<svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' +
      '<use href="#' +
      TOAST_ICONS[tone] +
      '"></use></svg></span>' +
      '<div class="min-w-0 flex-1">' +
      '<p class="toast-title text-sm font-semibold text-slate-900 dark:text-white"></p>' +
      '<p class="toast-body mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400"></p>' +
      '</div>' +
      '<button type="button" class="toast-close" aria-label="Dismiss notification">' +
      '<svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' +
      '<use href="#i-x"></use></svg></button>';

    toast.querySelector('.toast-title').textContent = title;
    var bodyElement = toast.querySelector('.toast-body');
    if (message) {
      bodyElement.textContent = message;
    } else {
      bodyElement.remove();
    }

    var removed = false;
    var timer;

    function remove() {
      if (removed) return;
      removed = true;
      clearTimeout(timer);
      toast.classList.add('pointer-events-none', 'opacity-0', 'translate-y-1');
      setTimeout(function () {
        toast.remove();
      }, 200);
    }

    toast.querySelector('.toast-close').addEventListener('click', remove);
    toast.addEventListener('mouseenter', function () {
      clearTimeout(timer);
    });
    toast.addEventListener('mouseleave', function () {
      timer = setTimeout(remove, 2500);
    });

    toast.querySelector('.toast-close').title = 'Dismiss';
    while (dom.toastStack.children.length >= 3) {
      dom.toastStack.firstElementChild.remove();
    }
    dom.toastStack.appendChild(toast);
    timer = setTimeout(remove, tone === 'error' ? 7000 : 4800);
  }

  /* ------------------------------------------------------------------ */
  /* Options                                                             */
  /* ------------------------------------------------------------------ */

  function optionValue(name) {
    var input = optionInputs.find(function (item) {
      return item.getAttribute('data-option') === name;
    });
    return !!(input && input.checked);
  }

  function syncDedupeVisibility() {
    var enabled = optionValue('removeDuplicates');
    dom.dedupeControls.classList.toggle('hidden', !enabled);
    dom.dedupeColumn.disabled = !enabled || state.busy;
  }

  function resetOptionInputs() {
    optionInputs.forEach(function (input) {
      input.checked = DEFAULT_OPTIONS[input.getAttribute('data-option')] !== false;
    });
    dom.dedupeColumn.value = 'all';
    syncDedupeVisibility();
  }

  function readOptions() {
    var options = {};
    optionInputs.forEach(function (input) {
      options[input.getAttribute('data-option')] = input.checked;
    });
    options.dedupeColumn =
      dom.dedupeColumn.value === 'all' ? null : Number.parseInt(dom.dedupeColumn.value, 10);
    return options;
  }

  function markDirty() {
    if (!state.cleaned) return;
    dom.staleNote.classList.remove('hidden');
  }

  function handleOptionChange() {
    syncDedupeVisibility();
    markDirty();
  }

  /* ------------------------------------------------------------------ */
  /* Busy states                                                         */
  /* ------------------------------------------------------------------ */

  function showDropBusy(show) {
    if (show) {
      dom.dropIdle.classList.add('hidden');
      dom.dropBusy.classList.remove('hidden');
    } else {
      dom.dropBusy.classList.add('hidden');
      dom.dropIdle.classList.remove('hidden');
    }
  }

  function showPreviewLoading(show, message) {
    if (message) dom.previewLoadingText.textContent = message;
    dom.previewLoading.classList.toggle('hidden', !show);
    dom.previewLoading.classList.toggle('flex', show);
  }

  function setCleanButtonBusy(busy) {
    dom.cleanBtn.disabled = busy;
    dom.cleanBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
    dom.cleanBtnSpinner.classList.toggle('hidden', !busy);
    dom.cleanBtnIcon.classList.toggle('hidden', busy);
    dom.cleanBtnArrow.classList.toggle('hidden', busy);
    dom.cleanBtnLabel.textContent = busy ? 'Cleaning…' : 'Clean data';
  }

  function beginBusy(mode) {
    if (state.busy) return;
    state.busy = true;
    dom.dropzone.disabled = true;
    dom.sampleBtn.disabled = true;
    dom.replaceBtn.disabled = true;
    dom.resetOptions.disabled = true;
    dom.cleanBtn.disabled = true;
    dom.dedupeColumn.disabled = true;
    optionInputs.forEach(function (input) {
      input.disabled = true;
    });

    if (mode === 'clean') {
      setCleanButtonBusy(true);
      showPreviewLoading(true, 'Cleaning your data…');
    } else if (state.file) {
      showPreviewLoading(true, 'Reading your file…');
    } else {
      showDropBusy(true);
    }
  }

  function endBusy() {
    state.busy = false;
    dom.dropzone.disabled = false;
    dom.sampleBtn.disabled = false;
    dom.replaceBtn.disabled = false;
    dom.resetOptions.disabled = false;
    dom.cleanBtn.disabled = false;
    optionInputs.forEach(function (input) {
      input.disabled = false;
    });
    setCleanButtonBusy(false);
    showPreviewLoading(false);
    showDropBusy(false);
    syncDedupeVisibility();
  }

  /* ------------------------------------------------------------------ */
  /* API helpers                                                         */
  /* ------------------------------------------------------------------ */

  async function readJsonResponse(response) {
    var payload = null;
    var contentType = response.headers.get('content-type') || '';
    if (contentType.indexOf('application/json') !== -1) {
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
    }

    if (!response.ok) {
      var message =
        payload && payload.error && payload.error.message
          ? payload.error.message
          : 'The request failed with status ' + response.status + '.';
      var error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      error.code = payload && payload.error ? payload.error.code : null;
      throw error;
    }

    if (!payload) throw new Error('The server returned an unexpected response.');
    return payload;
  }

  function deleteServerFile(id) {
    if (!id) return;
    fetch('/api/files/' + encodeURIComponent(id), { method: 'DELETE', keepalive: true }).catch(function () {
      /* Best-effort cleanup; server storage expires on its own. */
    });
  }

  /* ------------------------------------------------------------------ */
  /* Upload                                                              */
  /* ------------------------------------------------------------------ */

  function populateDedupeColumns(headers) {
    while (dom.dedupeColumn.options.length > 1) {
      dom.dedupeColumn.remove(1);
    }
    headers.forEach(function (header, index) {
      var label = String(header);
      if (label.length > 44) label = label.slice(0, 43) + '…';
      var option = document.createElement('option');
      option.value = String(index);
      option.textContent = label;
      dom.dedupeColumn.appendChild(option);
    });
    dom.dedupeColumn.value = 'all';
  }

  function renderFileMeta(file) {
    dom.fileName.textContent = file.name;
    dom.fileName.title = file.name;
    dom.fileFormat.textContent = formatLabel(file);
    dom.fileRows.textContent = plural(file.rowCount, 'row', 'rows');
    dom.fileCols.textContent = plural(file.columnCount, 'column', 'columns');
    dom.fileSize.textContent = formatBytes(file.size);
  }

  function handleUploadSuccess(file, access) {
    state.file = file;
    state.file.access = access || null;
    state.cleaned = null;
    state.activeTab = 'original';
    state.paywallReason = null;

    dom.uploadPanel.classList.add('hidden');
    dom.editor.classList.remove('hidden');
    dom.previewSection.classList.remove('hidden');
    dom.results.classList.add('hidden');
    dom.warningsNote.classList.add('hidden');
    dom.warningsNote.textContent = '';
    dom.staleNote.classList.add('hidden');
    dom.tabCleaned.disabled = true;
    dom.tabCleaned.setAttribute('aria-selected', 'false');
    dom.tabOriginal.setAttribute('aria-selected', 'true');

    renderFileMeta(file);
    populateDedupeColumns(file.headers);
    resetOptionInputs();
    renderPreview('original');
    setStep('clean');
    updateFreeLimitNote();
    persistWorkspace();

    if (file.rowCount === 0) {
      showToast('info', 'Headers found, but no data rows', 'You can still adjust options, but there is nothing to clean yet.');
    } else if (access && access.allowed === false) {
      showToast(
        'info',
        'Large file loaded',
        'You can preview it now. Upgrade when you are ready to clean and download it.',
      );
    } else {
      showToast(
        'success',
        'File loaded',
        plural(file.rowCount, 'row', 'rows') + ' and ' + plural(file.columnCount, 'column', 'columns') + ' ready to clean.',
      );
    }

    requestAnimationFrame(function () {
      dom.workspace.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  async function uploadFile(file) {
    if (!file || state.busy) return;

    if (file.size === 0) {
      showToast('error', 'That file is empty', 'Choose a file that contains at least a header row.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      showToast('error', 'That file is too large', 'The upload limit is 10 MB. Try splitting the file first.');
      return;
    }

    var previousFileId = state.file ? state.file.id : null;
    var previousCleanedId = state.cleaned ? state.cleaned.id : null;

    beginBusy('upload');
    try {
      var formData = new FormData();
      formData.append('file', file);
      var response = await fetch('/api/upload', { method: 'POST', body: formData });
      var payload = await readJsonResponse(response);
      handleUploadSuccess(payload.file, payload.access);
      deleteServerFile(previousFileId);
      deleteServerFile(previousCleanedId);
    } catch (error) {
      showToast('error', 'Could not load that file', friendlyError(error));
    } finally {
      endBusy();
      dom.fileInput.value = '';
    }
  }

  async function loadSample() {
    if (state.busy || state.loadingSample) return;
    state.loadingSample = true;
    var previousMarkup = dom.sampleBtn.innerHTML;
    dom.sampleBtn.disabled = true;
    dom.sampleBtn.innerHTML = '<span class="spinner h-3.5 w-3.5"></span>Loading sample…';

    try {
      var response = await fetch('/api/sample');
      if (!response.ok) throw new Error('The sample file could not be loaded.');
      var text = await response.text();
      var file = new File([text], 'tidydata-messy-sample.csv', { type: 'text/csv' });
      await uploadFile(file);
    } catch (error) {
      showToast('error', 'Could not load the sample', friendlyError(error));
    } finally {
      state.loadingSample = false;
      dom.sampleBtn.innerHTML = previousMarkup;
      dom.sampleBtn.disabled = state.busy;
    }
  }

  function initUpload() {
    dom.dropzone.addEventListener('click', function () {
      if (!state.busy && !state.loadingSample) dom.fileInput.click();
    });

    dom.fileInput.addEventListener('change', function () {
      var file = dom.fileInput.files && dom.fileInput.files[0];
      if (file) uploadFile(file);
    });

    dom.sampleBtn.addEventListener('click', loadSample);
    dom.replaceBtn.addEventListener('click', function () {
      if (!state.busy && !state.loadingSample) dom.fileInput.click();
    });

    var dragDepth = 0;
    var activeClasses = [
      'border-brand-400',
      'bg-brand-50/70',
      'ring-4',
      'ring-brand-500/10',
      'dark:border-brand-400/60',
      'dark:bg-brand-400/[0.08]',
    ];

    function setDragging(active) {
      activeClasses.forEach(function (className) {
        dom.dropzone.classList.toggle(className, active);
      });
    }

    dom.dropzone.addEventListener('dragenter', function (event) {
      event.preventDefault();
      if (state.busy) return;
      dragDepth += 1;
      setDragging(true);
    });

    dom.dropzone.addEventListener('dragover', function (event) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });

    dom.dropzone.addEventListener('dragleave', function (event) {
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragging(false);
    });

    dom.dropzone.addEventListener('drop', function (event) {
      event.preventDefault();
      dragDepth = 0;
      setDragging(false);
      if (state.busy) return;
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) uploadFile(file);
    });

    ['dragenter', 'dragover', 'drop'].forEach(function (type) {
      window.addEventListener(type, function (event) {
        event.preventDefault();
      });
    });

    window.addEventListener('drop', function () {
      setDragging(false);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Preview table                                                       */
  /* ------------------------------------------------------------------ */

  function renderPreview(mode) {
    var data = mode === 'cleaned' ? state.cleaned : state.file;
    if (!data) return;

    state.activeTab = mode;
    dom.tabOriginal.setAttribute('aria-selected', mode === 'original' ? 'true' : 'false');
    dom.tabCleaned.setAttribute('aria-selected', mode === 'cleaned' ? 'true' : 'false');
    dom.tabCleaned.disabled = !state.cleaned;

    var headerRow = document.createElement('tr');
    var corner = document.createElement('th');
    corner.scope = 'col';
    corner.className = 'row-number';
    corner.textContent = '#';
    headerRow.appendChild(corner);

    (data.headers || []).forEach(function (header) {
      var th = document.createElement('th');
      th.scope = 'col';
      th.textContent = header;
      headerRow.appendChild(th);
    });
    dom.previewThead.replaceChildren(headerRow);

    var fragment = document.createDocumentFragment();
    (data.rows || []).forEach(function (row, rowIndex) {
      var tr = document.createElement('tr');
      var number = document.createElement('td');
      number.className = 'row-number';
      number.textContent = String(rowIndex + 1).padStart(2, '0');
      tr.appendChild(number);

      (data.headers || []).forEach(function (header, columnIndex) {
        var td = document.createElement('td');
        var span = document.createElement('span');
        var value = row[columnIndex];
        span.className = 'cell-truncate';

        if (value === null || value === undefined || value === '') {
          span.textContent = '—';
          span.classList.add('text-slate-300', 'dark:text-slate-600');
        } else {
          span.textContent = String(value);
          span.title = String(value);
          if (typeof value === 'number') {
            span.classList.add('tabular-nums');
          } else if (typeof value === 'boolean') {
            span.classList.add('font-medium');
            span.classList.add(value ? 'text-emerald-700' : 'text-slate-500');
            span.classList.add(value ? 'dark:text-emerald-400' : 'dark:text-slate-400');
          }
        }

        td.appendChild(span);
        tr.appendChild(td);
      });

      fragment.appendChild(tr);
    });

    if (!data.rows || data.rows.length === 0) {
      var emptyTr = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.colSpan = (data.headers || []).length + 1;
      emptyCell.className = 'px-5 py-16 text-center text-sm text-slate-400 dark:text-slate-500';
      emptyCell.textContent =
        mode === 'cleaned'
          ? 'No data rows survived this clean-up. Headers are still included in the download.'
          : 'No data rows were found under these headers.';
      emptyTr.appendChild(emptyCell);
      fragment.appendChild(emptyTr);
    }

    dom.previewTbody.replaceChildren(fragment);

    var rowCount = Number(data.rowCount) || 0;
    var shown = data.rows ? data.rows.length : 0;
    dom.previewMeta.textContent = data.truncated
      ? 'Showing the first ' + formatNumber(shown) + ' of ' + formatNumber(rowCount) + ' rows'
      : 'Showing all ' + formatNumber(rowCount) + ' rows';
    dom.previewCols.textContent = plural(Number(data.columnCount) || 0, 'column', 'columns');
    dom.previewCountBadge.textContent = plural(rowCount, 'row', 'rows');

    var panel = document.getElementById('preview-panel');
    if (panel) {
      panel.scrollTop = 0;
      panel.scrollLeft = 0;
    }
  }

  function setPreviewTab(mode) {
    if (mode === 'cleaned' && !state.cleaned) return;
    renderPreview(mode);
  }

  /* ------------------------------------------------------------------ */
  /* Results                                                             */
  /* ------------------------------------------------------------------ */

  function renderResults(cleaned) {
    var stats = cleaned.stats;
    var emptyRemoved = stats.emptyRowsRemoved + stats.emptyColumnsDropped;
    var cellsFixed = stats.cellsTrimmed + stats.valuesFormatted;
    var changes =
      stats.duplicatesRemoved +
      stats.emptyRowsRemoved +
      stats.emptyColumnsDropped +
      stats.headersAdjusted +
      cellsFixed;

    dom.statRows.textContent = formatNumber(stats.rowsOut);
    dom.statRowsSub.textContent = 'of ' + formatNumber(stats.rowsIn) + ' input rows';
    dom.statDupes.textContent = formatNumber(stats.duplicatesRemoved);
    dom.statDupesSub.textContent = stats.duplicatesRemoved
      ? 'repeated rows removed'
      : 'no duplicates found';
    dom.statEmpty.textContent = formatNumber(emptyRemoved);
    dom.statEmptySub.textContent =
      formatNumber(stats.emptyRowsRemoved) + ' rows · ' + formatNumber(stats.emptyColumnsDropped) + ' columns';
    dom.statCells.textContent = formatNumber(cellsFixed);
    dom.statCellsSub.textContent =
      cellsFixed === 0
        ? 'no cell changes needed'
        : formatNumber(stats.valuesFormatted) +
          ' normalized · ' +
          formatNumber(stats.cellsTrimmed) +
          ' trimmed';

    if (stats.rowsOut === 0) {
      dom.resultsSubtitle.textContent =
        'No data rows remain after this recipe. Your download will include only the column headers.';
    } else if (changes === 0) {
      dom.resultsSubtitle.textContent =
        'Your data was already tidy. Here is a clean copy, ready to download.';
    } else {
      dom.resultsSubtitle.textContent =
        formatNumber(stats.rowsIn) +
        ' input rows became ' +
        formatNumber(stats.rowsOut) +
        ' clean rows across ' +
        plural(stats.columnsOut, 'column', 'columns') +
        '.';
    }

    var processingTime =
      stats.processingMs <= 1 ? 'under 1 ms' : formatNumber(stats.processingMs) + ' ms';
    var expiry = new Date(cleaned.expiresAt);
    var expiryLabel = expiry.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    dom.cleanedNote.textContent =
      'Cleaned in ' + processingTime + ' · download links expire around ' + expiryLabel + '.';

    if (cleaned.warnings && cleaned.warnings.length) {
      dom.warningsNote.textContent = cleaned.warnings.join(' ');
      dom.warningsNote.classList.remove('hidden');
    } else {
      dom.warningsNote.textContent = '';
      dom.warningsNote.classList.add('hidden');
    }

    dom.staleNote.classList.add('hidden');
    updatePaywall();
    updateFreeLimitNote();
  }

  /* ------------------------------------------------------------------ */
  /* Clean + download                                                    */
  /* ------------------------------------------------------------------ */

  async function cleanData() {
    if (!state.file || state.busy) return;

    beginBusy('clean');
    var cleanedSuccessfully = false;
    try {
      var response = await fetch('/api/clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: state.file.id, options: readOptions() }),
      });
      var payload = await readJsonResponse(response);
      var cleaned = payload.cleaned;

      state.cleaned = cleaned;
      state.activeTab = 'cleaned';
      state.paywallReason = null;
      dom.tabCleaned.disabled = false;
      persistWorkspace();
      renderResults(cleaned);
      renderPreview('cleaned');
      setStep('download');

      dom.results.classList.remove('hidden');
      var card = dom.results.querySelector('.card');
      if (card) {
        card.classList.remove('animate-rise');
        void card.offsetWidth;
        card.classList.add('animate-rise');
      }

      if (cleaned.rowCount === 0) {
        showToast('info', 'No data rows left', 'Check your options or upload a different file. Headers are still exportable.');
      } else {
        showToast(
          'success',
          'Data cleaned',
          plural(cleaned.rowCount, 'row', 'rows') +
            ' ready across ' +
            plural(cleaned.columnCount, 'column', 'columns') +
            '.',
        );
      }
      cleanedSuccessfully = true;
    } catch (error) {
      if (error.status === 402) {
        if (error.payload && error.payload.billing) applyBilling(error.payload.billing);
        state.paywallReason = 'CLEAN';
        updateFreeLimitNote();
        openCheckout('single', 'clean');
        showToast('info', 'This file needs a plan', friendlyError(error));
      } else {
        showToast('error', 'Could not clean that file', friendlyError(error));
      }
    } finally {
      endBusy();
    }

    if (cleanedSuccessfully) {
      requestAnimationFrame(function () {
        dom.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  async function downloadClean(format) {
    if (!state.cleaned || state.busy) return;
    var buttons = {
      csv: dom.downloadCsv,
      json: dom.downloadJson,
      ndjson: dom.downloadNdjson,
      tsv: dom.downloadTsv,
    };
    var button = buttons[format] || dom.downloadCsv;
    var previousMarkup = button.innerHTML;
    var failureStatus = 0;
    button.disabled = true;
    button.innerHTML = '<span class="spinner h-4 w-4"></span>Preparing…';

    try {
      var response = await fetch(
        '/api/download/' + encodeURIComponent(state.cleaned.id) + '?format=' + format,
      );
      failureStatus = response.status;

      if (!response.ok) {
        var payload = null;
        try {
          payload = await response.json();
        } catch (error) {
          payload = null;
        }
        if (response.status === 402 && payload && payload.billing) {
          applyBilling(payload.billing);
          state.paywallReason =
            payload.access && payload.access.reason ? payload.access.reason : 'EXPORT';
          updatePaywall();
          openCheckout('single', 'download', format);
        }
        throw new Error(
          (payload && payload.error && payload.error.message) ||
            'The download could not be prepared. Please clean your data again.',
        );
      }

      var blob = await response.blob();
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = baseName(state.cleaned.name) + '-cleaned.' + format;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 2000);

      state.paywallReason = null;
      updatePaywall();

      showToast(
        'success',
        format.toUpperCase() + ' download started',
        plural(state.cleaned.rowCount, 'row', 'rows') + ' exported. Check your downloads folder.',
      );

      refreshBilling({ silent: true }).then(function () {
        updatePaywall();
      });
    } catch (error) {
      if (failureStatus === 402) {
        showToast('info', 'This export needs an unlock', friendlyError(error));
      } else {
        showToast('error', 'Download failed', friendlyError(error));
      }
    } finally {
      button.disabled = false;
      button.innerHTML = previousMarkup;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Billing and checkout                                                */
  /* ------------------------------------------------------------------ */

  function planRadios() {
    return Array.prototype.slice.call(document.querySelectorAll('input[name="checkout-plan"]'));
  }

  function selectedPlan() {
    var checked = planRadios().find(function (radio) {
      return radio.checked;
    });
    return checked ? checked.value : state.checkoutPlan;
  }

  function currentLimit() {
    return Number(state.billing.highVolumeRowLimit) || 0;
  }

  function freeTier() {
    return state.billing.freeTier || DEFAULT_BILLING.freeTier;
  }

  function freeRowLimit() {
    return Number(freeTier().maxRows) || 0;
  }

  function freeSizeLimit() {
    return Number(freeTier().maxFileSizeBytes) || DEFAULT_BILLING.freeTier.maxFileSizeBytes;
  }

  function fileExceedsFreeTier(file) {
    if (!file) return false;
    return Number(file.rowCount) > freeRowLimit() || Number(file.size) > freeSizeLimit();
  }

  function hasExportAccess(entitlement) {
    if (!entitlement || !entitlement.active) return false;
    if (entitlement.plan === 'monthly') return true;
    return Number(entitlement.remainingExports) > 0;
  }

  function isHighVolume() {
    return Boolean(state.cleaned && Number(state.cleaned.rowCount) > currentLimit());
  }

  function updateFreeLimitNote() {
    if (!dom.freeLimitNote) return;

    var premium = hasExportAccess(state.billing.entitlement);
    if (!state.file || state.cleaned || premium || !fileExceedsFreeTier(state.file)) {
      setHidden(dom.freeLimitNote, true, 'flex');
      return;
    }

    var single = state.billing.prices.single.display || '$5';
    var limits = freeTier();
    var reason =
      Number(state.file.rowCount) > Number(limits.maxRows)
        ? 'This file has ' +
          formatNumber(state.file.rowCount) +
          ' rows and the free plan cleans up to ' +
          formatNumber(limits.maxRows) +
          ' rows.'
        : 'This file is ' +
          formatBytes(state.file.size) +
          ' and the free plan cleans files up to ' +
          formatNumber(limits.maxFileSizeMb) +
          ' MB.';

    if (dom.freeLimitCopy) {
      dom.freeLimitCopy.textContent =
        reason +
        ' Upgrade for large files, bulk processing, and NDJSON/TSV exports.';
    }
    if (dom.freeLimitPrice) dom.freeLimitPrice.textContent = single;
    setHidden(dom.freeLimitNote, false, 'flex');
  }

  function setHidden(element, hidden, displayClass) {
    if (!element) return;
    element.classList.toggle('hidden', hidden);
    if (displayClass) element.classList.toggle(displayClass, !hidden);
  }

  function updatePlanBadge() {
    if (!dom.planBadge) return;
    var entitlement = state.billing.entitlement;

    if (!hasExportAccess(entitlement)) {
      setHidden(dom.planBadge, true, 'inline-flex');
      dom.planBadge.textContent = '';
      dom.planBadge.removeAttribute('title');
      return;
    }

    var remaining = Number(entitlement.remainingExports) || 0;
    dom.planBadge.textContent =
      entitlement.plan === 'monthly'
        ? 'Pro · Unlimited'
        : remaining === 1
          ? '1 export credit'
          : remaining + ' export credits';
    dom.planBadge.title =
      entitlement.plan === 'monthly'
        ? 'Monthly plan active until ' + new Date(entitlement.expiresAt).toLocaleDateString()
        : 'Export pass valid until ' + new Date(entitlement.expiresAt).toLocaleString();
    setHidden(dom.planBadge, false, 'inline-flex');
  }

  function updatePricingUI() {
    var billing = state.billing;
    var single = billing.prices.single.display || '$5';
    var monthly = billing.prices.monthly.display || '$19';
    var limits = freeTier();

    if (dom.pricingSinglePrice) dom.pricingSinglePrice.textContent = single;
    if (dom.pricingMonthlyPrice) dom.pricingMonthlyPrice.textContent = monthly;
    if (dom.checkoutSinglePrice) dom.checkoutSinglePrice.textContent = single;
    if (dom.checkoutMonthlyPrice) dom.checkoutMonthlyPrice.textContent = monthly;
    if (dom.paywallPrice) dom.paywallPrice.textContent = single;
    if (dom.pricingFreeLimit) dom.pricingFreeLimit.textContent = formatNumber(limits.maxRows);
    if (dom.pricingFreeSize) dom.pricingFreeSize.textContent = formatNumber(limits.maxFileSizeMb);
    if (dom.checkoutFreeRows) dom.checkoutFreeRows.textContent = formatNumber(limits.maxRows);
    if (dom.checkoutFreeSize) dom.checkoutFreeSize.textContent = formatNumber(limits.maxFileSizeMb);

    if (dom.pricingModeText) {
      var note;
      if (billing.sandboxEnabled && billing.stripeConfigured) {
        note = 'Sandbox toggle available — test checkout without a real charge.';
      } else if (billing.sandboxEnabled) {
        note = 'Sandbox checkout is on. Add Stripe keys for real payments.';
      } else if (billing.stripeConfigured && billing.stripeMode === 'live') {
        note = 'Secure live checkout via Stripe.';
      } else if (billing.stripeConfigured) {
        note = 'Stripe test mode — no real money moves.';
      } else {
        note = 'Checkout needs Stripe keys; sandbox is disabled.';
      }
      dom.pricingModeText.textContent = note;
    }

    updateCheckoutSummary();
    updateFreeLimitNote();
  }

  function updatePaywall() {
    if (!dom.paywallNote) return;

    var highVolume = isHighVolume();
    var premiumFormat = state.paywallReason === 'PREMIUM_FORMAT';
    var entitlement = state.billing.entitlement;
    var canExport = hasExportAccess(entitlement);
    var requiresPremium =
      highVolume ||
      premiumFormat ||
      state.paywallReason === 'NO_CREDITS' ||
      state.paywallReason === 'NO_ENTITLEMENT';

    if (!state.cleaned || !requiresPremium || canExport) {
      setHidden(dom.paywallNote, true, 'flex');
      return;
    }

    var rowCount = formatNumber(state.cleaned.rowCount);
    var limit = formatNumber(currentLimit());
    var single = state.billing.prices.single.display || '$5';
    var limits = freeTier();

    if (dom.paywallTitle) {
      dom.paywallTitle.textContent = premiumFormat
        ? 'This export format is premium.'
        : 'This export is above the free limit.';
    }

    if (entitlement && entitlement.plan === 'single' && !hasExportAccess(entitlement)) {
      dom.paywallCopy.textContent =
        ' Your export pass has been used. Buy another pass or subscribe for unlimited downloads.';
    } else if (premiumFormat) {
      dom.paywallCopy.textContent =
        ' NDJSON and TSV are premium formats. Buy a pass or subscribe to unlock them along with large files and bulk processing.';
    } else if (highVolume) {
      dom.paywallCopy.textContent =
        ' This file has ' +
        rowCount +
        ' rows and the free download limit is ' +
        limit +
        '. Buy a pass or subscribe for unlimited downloads.';
    } else {
      dom.paywallCopy.textContent =
        ' This file has ' +
        rowCount +
        ' rows and the free plan covers up to ' +
        formatNumber(limits.maxRows) +
        ' rows and ' +
        formatNumber(limits.maxFileSizeMb) +
        ' MB. Buy a pass or subscribe to unlock it.';
    }

    if (dom.paywallPrice) dom.paywallPrice.textContent = single;
    setHidden(dom.paywallNote, false, 'flex');
  }

  function syncCheckoutEntitlement() {
    if (!dom.checkoutEntitlement) return;
    var entitlement = state.billing.entitlement;

    if (!entitlement) {
      setHidden(dom.checkoutEntitlement, true);
      return;
    }

    var message;
    if (entitlement.plan === 'monthly' && hasExportAccess(entitlement)) {
      message =
        'Your monthly plan is active — large files, bulk processing, and premium exports are unlimited.';
    } else if (entitlement.plan === 'single' && hasExportAccess(entitlement)) {
      message =
        'You have ' +
        formatNumber(entitlement.remainingExports) +
        ' export ' +
        (Number(entitlement.remainingExports) === 1 ? 'credit' : 'credits') +
        ' ready on this browser.';
    } else {
      message = 'Your previous export pass has been used. Choose another pass to keep exporting.';
    }

    dom.checkoutEntitlement.textContent = message;
    setHidden(dom.checkoutEntitlement, false);
  }

  function updateCheckoutSummary() {
    var plan = selectedPlan();
    state.checkoutPlan = plan;
    var price =
      plan === 'monthly'
        ? state.billing.prices.monthly.display || '$19'
        : state.billing.prices.single.display || '$5';

    if (dom.checkoutTotal) dom.checkoutTotal.textContent = price;
    if (dom.checkoutRecurringNote) {
      dom.checkoutRecurringNote.textContent =
        plan === 'monthly' ? 'Billed monthly · renews automatically' : 'One-time payment';
    }
    if (dom.checkoutLegalNote) {
      dom.checkoutLegalNote.textContent =
        plan === 'monthly'
          ? 'Payments are processed securely by Stripe. The subscription renews monthly until cancelled.'
          : 'Payments are processed securely by Stripe. No card details touch this server.';
    }
  }

  function sandboxSelected() {
    if (!state.billing.sandboxEnabled) return false;
    if (!state.billing.stripeConfigured) return true;
    return Boolean(dom.sandboxToggle && dom.sandboxToggle.checked);
  }

  function syncCheckoutMode() {
    if (!dom.checkoutSubmit) return;
    var billing = state.billing;
    var sandboxAvailable = Boolean(billing.sandboxEnabled);

    if (dom.checkoutSandboxRow) {
      dom.checkoutSandboxRow.classList.toggle('hidden', !sandboxAvailable);
    }

    if (dom.sandboxToggle) {
      if (!sandboxAvailable) dom.sandboxToggle.checked = false;
      if (sandboxAvailable && !billing.stripeConfigured) dom.sandboxToggle.checked = true;
      dom.sandboxToggle.disabled = !sandboxAvailable || !billing.stripeConfigured;
    }

    var sandbox = sandboxSelected();
    var unavailable = !sandbox && !billing.stripeConfigured;

    dom.checkoutSubmit.disabled = state.checkoutBusy || unavailable;
    dom.checkoutSubmitSpinner.classList.toggle('hidden', !state.checkoutBusy);
    dom.checkoutSubmitArrow.classList.toggle('hidden', state.checkoutBusy);

    if (state.checkoutBusy) {
      dom.checkoutSubmitLabel.textContent = 'Starting checkout…';
    } else if (unavailable) {
      dom.checkoutSubmitLabel.textContent = 'Checkout unavailable';
    } else if (sandbox) {
      dom.checkoutSubmitLabel.textContent = 'Complete sandbox purchase';
    } else {
      dom.checkoutSubmitLabel.textContent = 'Continue to Stripe';
    }

    if (dom.checkoutModeText) {
      var mode;
      if (unavailable) {
        mode = 'Checkout is not configured. Add STRIPE_SECRET_KEY to your .env file or enable sandbox mode.';
      } else if (sandbox && !billing.stripeConfigured) {
        mode = 'Sandbox checkout only — Stripe keys are not configured, so this simulates a purchase with no charge.';
      } else if (sandbox) {
        mode = 'Sandbox mode is on — no card is required and no real payment is processed.';
      } else if (billing.stripeMode === 'test') {
        mode = 'Stripe test mode — you will be redirected to Stripe. Use test card 4242 4242 4242 4242.';
      } else {
        mode = 'You will be redirected to Stripe’s secure checkout. You can cancel before paying.';
      }
      dom.checkoutModeText.textContent = mode;
    }
  }

  function setCheckoutBusy(busy) {
    state.checkoutBusy = busy;
    syncCheckoutMode();
  }

  function clearCheckoutError() {
    if (!dom.checkoutError) return;
    dom.checkoutError.textContent = '';
    dom.checkoutError.classList.add('hidden');
  }

  function showCheckoutError(message) {
    if (!dom.checkoutError) return;
    dom.checkoutError.textContent = message;
    dom.checkoutError.classList.remove('hidden');
  }

  function openCheckout(plan, reason, format) {
    if (!dom.checkoutModal) return;
    state.checkoutTrigger = document.activeElement;
    state.checkoutPlan = plan === 'monthly' ? 'monthly' : 'single';
    state.checkoutReason = reason || null;
    state.checkoutFormat = format || null;

    planRadios().forEach(function (radio) {
      radio.checked = radio.value === state.checkoutPlan;
    });

    clearCheckoutError();
    updateCheckoutSummary();
    syncCheckoutEntitlement();
    syncCheckoutMode();

    dom.checkoutModal.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    window.setTimeout(function () {
      if (dom.checkoutClose) dom.checkoutClose.focus();
    }, 30);

    if (!state.billingReady) {
      refreshBilling({ silent: true }).then(function () {
        syncCheckoutEntitlement();
        syncCheckoutMode();
      });
    }
  }

  function closeCheckout() {
    if (!dom.checkoutModal) return;
    dom.checkoutModal.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
    if (state.checkoutTrigger && typeof state.checkoutTrigger.focus === 'function') {
      state.checkoutTrigger.focus();
    }
    state.checkoutTrigger = null;
  }

  function handleCheckoutKeys(event) {
    if (!dom.checkoutModal || dom.checkoutModal.classList.contains('hidden')) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      closeCheckout();
      return;
    }

    if (event.key !== 'Tab') return;
    var focusable = Array.prototype.slice
      .call(
        dom.checkoutModal.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      )
      .filter(function (element) {
        return element.offsetParent !== null;
      });
    if (!focusable.length) return;

    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function refreshBilling(options) {
    try {
      var response = await fetch('/api/billing/status', { cache: 'no-store' });
      var payload = await readJsonResponse(response);
      applyBilling(payload.billing);
      return state.billing;
    } catch (error) {
      if (!options || !options.silent) {
        showToast('error', 'Billing is unavailable', friendlyError(error));
      }
      return null;
    }
  }

  function applyBilling(next) {
    var incoming = next && typeof next === 'object' ? next : {};
    var prices = incoming.prices || {};

    state.billing = Object.assign({}, DEFAULT_BILLING, incoming, {
      prices: {
        single: Object.assign({}, DEFAULT_BILLING.prices.single, prices.single || {}),
        monthly: Object.assign({}, DEFAULT_BILLING.prices.monthly, prices.monthly || {}),
      },
      freeTier: Object.assign({}, DEFAULT_BILLING.freeTier, incoming.freeTier || {}),
      premiumExportFormats: Array.isArray(incoming.premiumExportFormats)
        ? incoming.premiumExportFormats
        : DEFAULT_BILLING.premiumExportFormats,
      entitlement: incoming.entitlement || null,
    });
    state.billingReady = true;

    if (dom.sandboxToggle && !state.sandboxTouched) {
      dom.sandboxToggle.checked =
        Boolean(state.billing.sandboxEnabled) &&
        (!state.billing.stripeConfigured || state.billing.stripeMode !== 'live');
    }

    updatePricingUI();
    updatePlanBadge();
    syncCheckoutMode();
    updatePaywall();
  }

  async function startCheckout() {
    if (state.checkoutBusy) return;
    var plan = selectedPlan();
    var sandbox = sandboxSelected();

    clearCheckoutError();
    setCheckoutBusy(true);

    try {
      var response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: plan, sandbox: sandbox }),
      });
      var payload = await readJsonResponse(response);

      if (payload.sandbox) {
        if (payload.billing) applyBilling(payload.billing);
        var sandboxReason = state.checkoutReason;
        var sandboxFormat = state.checkoutFormat;
        setCheckoutBusy(false);
        closeCheckout();
        updatePaywall();
        showToast(
          'success',
          'Sandbox purchase complete',
          plan === 'monthly'
            ? 'Unlimited large-file cleaning and premium exports are unlocked on this browser.'
            : 'One premium export credit is ready. Large files and NDJSON/TSV exports are unlocked.',
        );
        resumeAfterUnlock(sandboxReason, sandboxFormat);
      } else if (payload.url) {
        if (state.checkoutReason === 'clean') {
          rememberPendingAction('clean');
        } else if (state.checkoutReason === 'download') {
          rememberPendingAction('download', { format: state.checkoutFormat || 'csv' });
        }
        persistWorkspace();
        window.location.assign(payload.url);
      } else {
        throw new Error('Stripe did not return a checkout link. Please try again.');
      }
    } catch (error) {
      clearPendingAction();
      showCheckoutError(friendlyError(error));
      showToast('error', 'Checkout could not start', friendlyError(error));
    } finally {
      setCheckoutBusy(false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Workspace persistence                                               */
  /* ------------------------------------------------------------------ */

  function rememberPendingAction(action, extra) {
    try {
      sessionStorage.setItem(
        PENDING_KEY,
        JSON.stringify(
          Object.assign({ action: action, at: Date.now() }, extra && typeof extra === 'object' ? extra : {}),
        ),
      );
    } catch (error) {
      /* Storage is optional. */
    }
  }

  function clearPendingAction() {
    try {
      sessionStorage.removeItem(PENDING_KEY);
    } catch (error) {
      /* Storage is optional. */
    }
  }

  function readPendingAction() {
    var pending = null;
    try {
      var raw = sessionStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      pending = JSON.parse(raw);
    } catch (error) {
      return null;
    }

    if (
      !pending ||
      (pending.action !== 'clean' && pending.action !== 'download') ||
      !pending.at ||
      Date.now() - pending.at > 60 * 60 * 1000
    ) {
      clearPendingAction();
      return null;
    }
    return pending;
  }

  function resumeAfterUnlock(reason, format) {
    if (reason === 'clean' && state.file) {
      showToast('info', 'Unlocked', 'Cleaning your saved file now…');
      cleanData();
    } else if (reason === 'download' && state.cleaned) {
      downloadClean(format || 'csv');
    }
  }

  function resumePendingAction() {
    var pending = readPendingAction();
    if (!pending) return;
    clearPendingAction();

    if (!state.file) return;

    if (pending.action === 'clean') {
      showToast('info', 'Payment confirmed', 'Large-file cleaning is unlocked. Cleaning your saved file now…');
      cleanData();
    } else if (pending.action === 'download' && state.cleaned) {
      showToast('info', 'Payment confirmed', 'Your premium export is unlocked. Preparing your download now…');
      downloadClean(pending.format || 'csv');
    }
  }

  function persistWorkspace() {
    if (!state.file) {
      try {
        sessionStorage.removeItem(WORKSPACE_KEY);
      } catch (error) {
        /* Storage is optional. */
      }
      return;
    }

    try {
      sessionStorage.setItem(
        WORKSPACE_KEY,
        JSON.stringify({
          file: state.file,
          cleaned: state.cleaned,
          options: readOptions(),
          savedAt: Date.now(),
        }),
      );
    } catch (error) {
      /* Large previews can exceed storage; checkout still works. */
    }
  }

  function readSavedWorkspace() {
    var saved = null;
    try {
      var raw = sessionStorage.getItem(WORKSPACE_KEY);
      if (!raw) return null;
      saved = JSON.parse(raw);
    } catch (error) {
      return null;
    }

    if (!saved || !saved.file || !saved.file.id) {
      try {
        sessionStorage.removeItem(WORKSPACE_KEY);
      } catch (error) {
        /* Ignore. */
      }
      return null;
    }

    if (saved.file.expiresAt && saved.file.expiresAt <= Date.now()) {
      try {
        sessionStorage.removeItem(WORKSPACE_KEY);
      } catch (error) {
        /* Ignore. */
      }
      return null;
    }

    if (saved.cleaned && saved.cleaned.expiresAt && saved.cleaned.expiresAt <= Date.now()) {
      saved.cleaned = null;
    }
    return saved;
  }

  function applySavedOptions(options) {
    if (!options || typeof options !== 'object') return;
    optionInputs.forEach(function (input) {
      var name = input.getAttribute('data-option');
      if (typeof options[name] === 'boolean') input.checked = options[name];
    });
    dom.dedupeColumn.value =
      Number.isInteger(options.dedupeColumn) && options.dedupeColumn >= 0
        ? String(options.dedupeColumn)
        : 'all';
    syncDedupeVisibility();
  }

  function restoreWorkspace() {
    if (state.file) return false;
    var saved = readSavedWorkspace();
    if (!saved) return false;

    state.file = saved.file;
    state.cleaned = saved.cleaned || null;

    dom.uploadPanel.classList.add('hidden');
    dom.editor.classList.remove('hidden');
    dom.previewSection.classList.remove('hidden');
    dom.results.classList.add('hidden');
    dom.staleNote.classList.add('hidden');

    renderFileMeta(state.file);
    populateDedupeColumns(state.file.headers || []);
    applySavedOptions(saved.options);

    if (state.cleaned) {
      state.activeTab = 'cleaned';
      dom.tabCleaned.disabled = false;
      dom.tabCleaned.setAttribute('aria-selected', 'true');
      dom.tabOriginal.setAttribute('aria-selected', 'false');
      renderResults(state.cleaned);
      renderPreview('cleaned');
      dom.results.classList.remove('hidden');
      setStep('download');
    } else {
      state.activeTab = 'original';
      renderPreview('original');
      setStep('clean');
    }

    updatePaywall();
    updateFreeLimitNote();
    return true;
  }

  function consumeCheckoutQuery() {
    var params = new URLSearchParams(window.location.search);
    var checkout = params.get('checkout');
    var plan = params.get('plan');

    if (checkout) {
      params.delete('checkout');
      params.delete('plan');
      var query = params.toString();
      try {
        history.replaceState(
          {},
          '',
          window.location.pathname + (query ? '?' + query : '') + window.location.hash,
        );
      } catch (error) {
        /* Older browsers can ignore this. */
      }
    }

    return checkout ? { type: checkout, plan: plan } : null;
  }

  function showCheckoutNotice(notice) {
    if (!notice) return;

    if (notice.type === 'success') {
      var entitlement = state.billing.entitlement;
      if (entitlement && entitlement.plan === 'monthly') {
        showToast(
          'success',
          'Your monthly plan is active',
          'Large files, bulk processing, and premium exports are now unlimited.',
        );
      } else if (entitlement) {
        showToast(
          'success',
          'Your export pass is ready',
          'Large files and NDJSON/TSV exports are unlocked for 24 hours.',
        );
      } else {
        showToast(
          'success',
          'Payment received',
          'Your purchase was confirmed. Head back to your file to continue.',
        );
      }
    } else if (notice.type === 'cancelled') {
      showToast(
        'info',
        'Checkout cancelled',
        'No charge was made. Your cleaned data is still here whenever you are ready.',
      );
    } else if (notice.type === 'failed') {
      showToast(
        'error',
        'Could not confirm that payment',
        'If your card was charged, wait a moment and refresh this page. Otherwise, try checkout again.',
      );
    }
  }

  function initBillingUI() {
    document.querySelectorAll('[data-checkout-plan]').forEach(function (button) {
      button.addEventListener('click', function () {
        openCheckout(button.getAttribute('data-checkout-plan'));
      });
    });

    if (dom.unlockBtn) {
      dom.unlockBtn.addEventListener('click', function () {
        openCheckout('single', 'export');
      });
    }

    if (dom.freeLimitUpgrade) {
      dom.freeLimitUpgrade.addEventListener('click', function () {
        openCheckout('single', 'clean');
      });
    }

    planRadios().forEach(function (radio) {
      radio.addEventListener('change', function () {
        state.checkoutPlan = radio.value;
        clearCheckoutError();
        updateCheckoutSummary();
      });
    });

    if (dom.sandboxToggle) {
      dom.sandboxToggle.addEventListener('change', function () {
        state.sandboxTouched = true;
        syncCheckoutMode();
      });
    }

    if (dom.checkoutClose) dom.checkoutClose.addEventListener('click', closeCheckout);
    if (dom.checkoutSubmit) dom.checkoutSubmit.addEventListener('click', startCheckout);

    dom.checkoutModal.querySelectorAll('[data-close-checkout]').forEach(function (element) {
      element.addEventListener('click', closeCheckout);
    });

    document.addEventListener('keydown', handleCheckoutKeys);
  }

  function initBilling() {
    var notice = consumeCheckoutQuery();
    restoreWorkspace();

    refreshBilling({ silent: true }).then(function () {
      updatePaywall();
      updateFreeLimitNote();

      if (notice && notice.type === 'success' && readPendingAction()) {
        resumePendingAction();
        return;
      }

      if (notice) showCheckoutNotice(notice);
      if (notice && notice.type !== 'success') clearPendingAction();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Bootstrap                                                           */
  /* ------------------------------------------------------------------ */

  function init() {
    if (dom.year) dom.year.textContent = String(new Date().getFullYear());
    initTheme();
    initUpload();

    optionInputs.forEach(function (input) {
      input.addEventListener('change', handleOptionChange);
    });

    dom.dedupeColumn.addEventListener('change', markDirty);

    dom.resetOptions.addEventListener('click', function () {
      resetOptionInputs();
      markDirty();
    });

    dom.cleanBtn.addEventListener('click', cleanData);
    dom.downloadCsv.addEventListener('click', function () {
      downloadClean('csv');
    });
    dom.downloadJson.addEventListener('click', function () {
      downloadClean('json');
    });
    if (dom.downloadNdjson) {
      dom.downloadNdjson.addEventListener('click', function () {
        downloadClean('ndjson');
      });
    }
    if (dom.downloadTsv) {
      dom.downloadTsv.addEventListener('click', function () {
        downloadClean('tsv');
      });
    }

    dom.tabOriginal.addEventListener('click', function () {
      setPreviewTab('original');
    });
    dom.tabCleaned.addEventListener('click', function () {
      setPreviewTab('cleaned');
    });

    [dom.tabOriginal, dom.tabCleaned].forEach(function (tab) {
      tab.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        if (
          event.key === 'ArrowRight' &&
          state.cleaned &&
          dom.tabOriginal.getAttribute('aria-selected') === 'true'
        ) {
          dom.tabCleaned.focus();
          setPreviewTab('cleaned');
        } else if (event.key === 'ArrowLeft') {
          dom.tabOriginal.focus();
          setPreviewTab('original');
        }
      });
    });

    syncDedupeVisibility();
    setStep('upload');
    initBillingUI();
    initBilling();
  }

  init();
})();
