(() => {
  'use strict';

  const gasUrl = window.SAI_VERIFY_GAS_URL;
  const $ = (id) => document.getElementById(id);
  const startButton = $('start-scan');
  const stopButton = $('stop-scan');
  const statusLine = $('camera-status');
  const resultPanel = $('result-panel');
  let scanner = null;
  let busy = false;

  function setCameraStatus(message) {
    statusLine.textContent = message;
  }

  function text(value) {
    return value === null || value === undefined || value === '' ? '—' : String(value);
  }

  function makeDetail(label, value) {
    const item = document.createElement('div');
    item.className = 'detail-item';
    const name = document.createElement('span');
    name.textContent = label;
    const content = document.createElement('strong');
    content.textContent = text(value);
    item.append(name, content);
    return item;
  }

  function showResult(data) {
    const v = data && data.verification ? data.verification : data;
    const outcome = String(v.outcome || 'INVALID');
    const valid = outcome === 'GENUINE_VALID';
    const warning = outcome === 'GENUINE_CLEARANCE_ISSUE';
    const banner = $('result-banner');

    banner.className = 'result-banner ' + (valid ? 'valid' : warning ? 'warning' : 'danger');
    $('result-symbol').textContent = valid ? '✓' : warning ? '!' : '×';
    $('result-title').textContent = text(v.label || 'Unable to verify');
    $('result-message').textContent = text(v.message || 'The verification service returned no details.');

    const student = v.student || null;
    const studentBlock = $('student-details');
    studentBlock.hidden = !student;
    $('student-name').textContent = student ? text(student.name) : '';
    $('student-id').textContent = student ? 'Student ID: ' + text(student.id) : '';
    $('student-school').textContent = student ? text(student.schoolName) : '';
    $('student-major').textContent = student ? text(student.major) : '';

    const photo = $('student-photo');
    if (student && student.photoDataUri &&
        /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(student.photoDataUri)) {
      photo.src = student.photoDataUri;
      photo.hidden = false;
    } else {
      photo.removeAttribute('src');
      photo.hidden = true;
    }

    const ticket = v.ticket || null;
    const ticketBlock = $('ticket-details');
    ticketBlock.replaceChildren();
    ticketBlock.hidden = !ticket;
    if (ticket) {
      ticketBlock.append(
        makeDetail('Ticket ID', ticket.ticketId),
        makeDetail('Ticket version', ticket.version),
        makeDetail('Ticket type', ticket.ticketType),
        makeDetail('Ticket status', ticket.status),
        makeDetail('Course code', ticket.courseCode),
        makeDetail('Generated', ticket.generatedAt)
      );
    }

    const courses = Array.isArray(v.courses) ? v.courses : [];
    $('course-details').hidden = courses.length === 0;
    const list = $('course-list');
    list.replaceChildren();
    courses.forEach((course) => {
      const row = document.createElement('div');
      row.className = 'course-row';
      const title = document.createElement('strong');
      title.textContent = [course.courseCode, course.courseName].filter(Boolean).join(' — ');
      const meta = document.createElement('span');
      meta.textContent = [course.date, course.time, course.venue].filter(Boolean).join(' · ');
      row.append(title, meta);
      list.append(row);
    });

    resultPanel.hidden = false;
    resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function verifyViaJsonp(qrPayload) {
    return new Promise((resolve, reject) => {
      const callbackName = 'saiFacultyQrCallback';
      const script = document.createElement('script');
      let settled = false;
      let timeoutId;

      const cleanup = () => {
        if (script.parentNode) script.parentNode.removeChild(script);
        try {
          delete window[callbackName];
        } catch (_) {
          window[callbackName] = undefined;
        }
        if (timeoutId) clearTimeout(timeoutId);
      };

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };

      timeoutId = setTimeout(
        () => finish(reject, new Error('Verification timed out. Check your internet connection and try again.')),
        20000
      );

      window[callbackName] = (data) => finish(resolve, data);
      script.onerror = () => finish(
        reject,
        new Error('Could not reach Google Apps Script. Check the deployment URL and web app access settings.')
      );

      const separator = gasUrl.includes('?') ? '&' : '?';
      const params = new URLSearchParams({
        action: 'facultyQrVerify',
        callback: callbackName,
        q: qrPayload,
        _: String(Date.now())
      });
      script.src = gasUrl + separator + params.toString();
      script.async = true;
      document.head.appendChild(script);
    });
  }

  async function verify(payload) {
    if (busy) return;

    if (!gasUrl || !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(gasUrl)) {
      showError('The Apps Script verification URL is missing or invalid. Please contact the examination office.');
      return;
    }

    const qrPayload = String(payload || '').trim();
    if (!qrPayload) {
      showError('No QR ticket data was provided. Scan the hall-ticket QR code again.');
      return;
    }

    busy = true;
    startButton.disabled = true;
    setCameraStatus('Checking ticket against university records…');
    resultPanel.hidden = true;

    try {
      const data = await verifyViaJsonp(qrPayload);
      if (!data || !data.ok) {
        throw new Error((data && data.message) || 'The verification service could not complete the request.');
      }
      showResult(data.verification);
      setCameraStatus('Verification completed. Scan another ticket when ready.');
    } catch (error) {
      showError(error.message || 'Network error. Check your connection and try again.');
    } finally {
      busy = false;
      startButton.disabled = false;
    }
  }

  function showError(message) {
    showResult({
      outcome: 'SERVICE_ERROR',
      label: 'Unable to verify',
      message: message
    });
    setCameraStatus(message);
  }

  async function stopScanner() {
    if (!scanner) return;
    try {
      if (scanner.isScanning) await scanner.stop();
    } catch (_) {}
    try {
      await scanner.clear();
    } catch (_) {}
    scanner = null;
    stopButton.disabled = true;
    startButton.disabled = false;
  }

  async function startScanner() {
    if (busy) return;
    if (!window.Html5Qrcode) {
      setCameraStatus('QR scanner library did not load. Check your internet connection.');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraStatus('Camera access requires HTTPS and a supported mobile browser.');
      return;
    }

    try {
      startButton.disabled = true;
      setCameraStatus('Requesting camera permission…');
      $('reader-placeholder')?.remove();
      scanner = new Html5Qrcode('reader', { verbose: false });

      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: (w, h) => ({
            width: Math.min(250, Math.floor(w * 0.82)),
            height: Math.min(250, Math.floor(h * 0.82))
          }),
          aspectRatio: 1.0
        },
        async (decodedText) => {
          if (busy) return;
          await stopScanner();
          await verify(decodedText);
        },
        () => {}
      );

      stopButton.disabled = false;
      setCameraStatus('Camera active. Point it at the hall ticket QR code.');
    } catch (error) {
      await stopScanner();
      startButton.disabled = false;
      setCameraStatus('Could not start the camera. Allow camera access in browser settings and ensure this page is opened over HTTPS.');
    }
  }

  startButton.addEventListener('click', startScanner);
  stopButton.addEventListener('click', async () => {
    await stopScanner();
    setCameraStatus('Camera stopped.');
  });

  $('manual-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = $('qr-input').value.trim();
    if (value) await verify(value);
  });

  $('scan-again').addEventListener('click', () => {
    resultPanel.hidden = true;
    $('qr-input').value = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    startScanner();
  });
})();
