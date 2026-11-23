/*
 * Formularios de contacto para la copia estática (GitHub Pages).
 *
 * Sustituye el envío de Contact Form 7 (que necesita WordPress) por validación
 * en el navegador + la Cloud Function `contactoWeb` del proyecto Firebase
 * grupodelgado-prod (la misma que usan delgadoseleccion.com, cepasconhistoria.com,
 * conservaslabrujula.com y conservasramonpena.com), que guarda la
 * solicitud y la envía por correo. La llamada va protegida con App Check
 * (reCAPTCHA Enterprise), que se carga al empezar a rellenar un formulario.
 *
 * Formularios de esta web:
 *   - Contacto (portada): formulario de contacto de Divi (nombre y correo
 *     obligatorios, mensaje opcional) con el captcha de suma de Divi, que se
 *     comprueba aquí antes de enviar.
 *   - También admite el módulo Email Optin (newsletter) de Divi y Contact Form 7,
 *     por si se añaden.
 *
 * CONFIGURACIÓN
 *   recaptchaSiteKey: clave de sitio de reCAPTCHA Enterprise registrada en App Check.
 *                     Debe tener el dominio www.laselecciondelsumiller.com en su lista de dominios.
 *                     Si se deja vacía, al enviar se abre el programa de correo
 *                     del visitante con el mensaje ya redactado (mailto) a fallbackEmail
 *                     (web@grupo-delgado.com).
 */
(function () {
	'use strict';

	var CONFIG = {
		recaptchaSiteKey: '6LdxFSMuAAAAAA0ImKsJQ0ge1lWmgDTuso1crLmH',
		firebase: {
			apiKey: 'AIzaSyAUxsnbJHWXhgpdf8-WrlsZqg3YR6K56zY',
			authDomain: 'grupodelgado-prod.firebaseapp.com',
			projectId: 'grupodelgado-prod',
			appId: '1:372017317721:web:3558356a66cd5fc5166e48'
		},
		region: 'europe-west1',
		functionName: 'contactoWeb',
		sdk: 'https://www.gstatic.com/firebasejs/11.0.2/',
		siteName: 'La Selección del Sumiller',
		fallbackEmail: 'web@grupo-delgado.com'
	};

	var MSG = {
		required: 'El campo es obligatorio.',
		acceptance: 'Debes aceptar los términos y condiciones antes de enviar tu mensaje.',
		email: 'La dirección de correo electrónico no es válida.',
		tel: 'El número de teléfono no es válido.',
		pattern: 'El formato del campo no es válido.',
		invalid: 'Uno o más campos tienen un error. Por favor, revísalos e inténtalo de nuevo.',
		sent: 'Gracias por tu mensaje. Ha sido enviado.',
		failed: 'Hubo un error intentando enviar tu mensaje. Por favor, inténtalo de nuevo más tarde.',
		mailto: 'Se ha abierto tu programa de correo con el mensaje preparado. Pulsa «Enviar» en él para completar el envío.'
	};

	var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	var TEL_RE = /^[+0-9\s().\-]{6,}$/;

	function clean(s) {
		return (s || '').replace(/\s+/g, ' ').trim();
	}

	/* ---------- Descripción de campos ----------
	 * Contact Form 7 en esta web usa dos formas:
	 *   <p><label> Nombre<br><span class="wpcf7-form-control-wrap">control</span></label></p>
	 *   <p>¿Eres particular o empresa?<br><span class="wpcf7-form-control-wrap">radios</span></p>
	 * La etiqueta es el texto del <p> que no pertenece al control.
	 */
	function labelFor(wrap) {
		var p = wrap.closest('p') || wrap.parentNode;
		var copy = p.cloneNode(true);
		var inner = copy.querySelector('.wpcf7-form-control-wrap');
		if (inner) inner.remove();
		return clean(copy.textContent).replace(/[:*]+$/, '').replace(/\s*\(opcional\)$/i, '').trim();
	}

	function cf7Fields(form) {
		var out = [];
		form.querySelectorAll('.wpcf7-form-control-wrap').forEach(function (wrap) {
			var radios = wrap.querySelectorAll('input[type=radio]');
			var el = radios.length ? radios[0] : wrap.querySelector('input, select, textarea');
			if (!el) return;
			var isAcceptance = !!wrap.querySelector('.wpcf7-acceptance');
			out.push({
				el: el,
				group: radios.length ? Array.prototype.slice.call(radios) : null,
				wrap: wrap,
				label: isAcceptance ? 'Política de privacidad' : labelFor(wrap) || el.name,
				required: isAcceptance || el.getAttribute('aria-required') === 'true' ||
					!!wrap.querySelector('[aria-required="true"]'),
				kind: isAcceptance ? 'acceptance' : radios.length ? 'radio' : el.type === 'email' ? 'email' : el.type === 'tel' ? 'tel' : 'text'
			});
		});
		return out;
	}

	function valueOf(field) {
		if (field.kind === 'acceptance') return field.el.checked ? 'Aceptada' : 'No aceptada';
		if (field.group) {
			var checked = field.group.filter(function (r) { return r.checked; })[0];
			return checked ? checked.value : '';
		}
		return field.el.value.trim();
	}

	function validate(field) {
		var filled = field.kind === 'acceptance' ? field.el.checked : valueOf(field) !== '';
		if (field.required && !filled) return field.kind === 'acceptance' ? MSG.acceptance : MSG.required;
		if (field.kind === 'acceptance' || field.group || !filled) return '';
		var v = valueOf(field);
		if (field.kind === 'email' && !EMAIL_RE.test(v)) return MSG.email;
		if (field.kind === 'tel' && !TEL_RE.test(v)) return MSG.tel;
		var pattern = field.el.getAttribute('pattern');
		if (pattern && !new RegExp('^(?:' + pattern + ')$').test(v)) return field.el.getAttribute('title') || MSG.pattern;
		return '';
	}

	/* ---------- Envío ---------- */

	// Lo que recibe la Cloud Function contactoWeb (mismo formato que delgadoseleccion.com).
	function buildPayload(fields) {
		var email = '';
		var campos = fields.map(function (f) {
			var valor = valueOf(f);
			if (f.kind === 'email' && !email) email = valor;
			return { etiqueta: f.label, valor: valor };
		});
		var h1 = '';
		var h1El = document.querySelector('h1');
		if (h1El) { // los <br> del título («Espinela<br>Roble») cuentan como espacio
			var copy = h1El.cloneNode(true);
			copy.querySelectorAll('br').forEach(function (br) { br.replaceWith(' '); });
			h1 = clean(copy.textContent);
		}
		return {
			formulario: CONFIG.siteName + ' – ' + (h1 || document.title),
			pagina: location.href,
			email: email,
			campos: campos
		};
	}

	// Carga Firebase + App Check una sola vez (módulos ES desde gstatic).
	var callablePromise = null;
	function getCallable() {
		if (!callablePromise) {
			callablePromise = Promise.all([
				import(CONFIG.sdk + 'firebase-app.js'),
				import(CONFIG.sdk + 'firebase-app-check.js'),
				import(CONFIG.sdk + 'firebase-functions.js')
			]).then(function (m) {
				var app = m[0].initializeApp(CONFIG.firebase, 'contacto-web');
				m[1].initializeAppCheck(app, {
					provider: new m[1].ReCaptchaEnterpriseProvider(CONFIG.recaptchaSiteKey),
					isTokenAutoRefreshEnabled: true
				});
				return m[2].httpsCallable(m[2].getFunctions(app, CONFIG.region), CONFIG.functionName);
			});
			callablePromise.catch(function () { callablePromise = null; });
		}
		return callablePromise;
	}

	function send(data) {
		if (!CONFIG.recaptchaSiteKey) {
			var body = data.campos.map(function (c) { return c.etiqueta + ': ' + c.valor; }).join('\n');
			location.href = 'mailto:' + CONFIG.fallbackEmail +
				'?subject=' + encodeURIComponent('Formulario web: ' + data.formulario) +
				'&body=' + encodeURIComponent(body);
			return Promise.resolve('mailto');
		}
		return getCallable().then(function (call) {
			return call(data);
		}).then(function () {
			return 'sent';
		});
	}

	// No se usa form.reset() ni se lanzan eventos "change": Contact Form 7 los
	// escucha y vuelve a validar (o llama a WordPress), y taparía el mensaje de éxito.
	function clearFields(form, fields) {
		var acceptance = false;
		fields.forEach(function (f) {
			if (f.group) f.group.forEach(function (r) { r.checked = false; });
			else if (f.el.type === 'checkbox') f.el.checked = false;
			else if (f.el.tagName === 'SELECT') f.el.selectedIndex = 0;
			else f.el.value = '';
			if (f.kind === 'acceptance') acceptance = true;
		});
		// Como hace Contact Form 7: sin aceptar la política, el botón queda desactivado.
		var button = form.querySelector('.wpcf7-submit');
		if (acceptance && button) button.disabled = true;
	}

	/* ---------- Interfaz Contact Form 7 ---------- */

	function cf7Status(form, status, message) {
		form.classList.remove('init', 'invalid', 'sent', 'failed', 'submitting', 'validating', 'resetting');
		form.classList.add(status);
		form.setAttribute('data-status', status);
		var out = form.querySelector('.wpcf7-response-output');
		if (out) {
			out.textContent = message || '';
			out.setAttribute('aria-hidden', message ? 'false' : 'true');
		}
		var sr = form.closest('.wpcf7') && form.closest('.wpcf7').querySelector('.screen-reader-response p');
		if (sr) sr.textContent = message || '';
	}

	function cf7ClearErrors(form) {
		form.querySelectorAll('.wpcf7-not-valid-tip').forEach(function (t) { t.remove(); });
		form.querySelectorAll('.wpcf7-not-valid').forEach(function (el) {
			el.classList.remove('wpcf7-not-valid');
			el.setAttribute('aria-invalid', 'false');
		});
	}

	function handleCf7(form) {
		var fields = cf7Fields(form);
		cf7ClearErrors(form);
		var firstBad = null;
		fields.forEach(function (f) {
			var err = validate(f);
			if (!err) return;
			var target = f.kind === 'acceptance' || f.group ? f.wrap.querySelector('.wpcf7-form-control') : f.el;
			target.classList.add('wpcf7-not-valid');
			f.el.setAttribute('aria-invalid', 'true');
			var tip = document.createElement('span');
			tip.className = 'wpcf7-not-valid-tip';
			tip.setAttribute('aria-hidden', 'true');
			tip.textContent = err;
			f.wrap.appendChild(tip);
			firstBad = firstBad || f.el;
		});
		if (firstBad) {
			cf7Status(form, 'invalid', MSG.invalid);
			firstBad.focus();
			return;
		}
		var button = form.querySelector('.wpcf7-submit');
		if (button) button.disabled = true;
		cf7Status(form, 'submitting', '');
		form.classList.add('init'); // mantiene el estilo base mientras envía
		send(buildPayload(fields)).then(function (result) {
			if (button) button.disabled = false;
			if (result === 'sent') clearFields(form, fields);
			cf7Status(form, 'sent', result === 'mailto' ? MSG.mailto : MSG.sent);
		}, function (err) {
			if (button) button.disabled = false;
			if (window.console) console.error('[formularios] Error al enviar:', err);
			cf7Status(form, 'failed', MSG.failed);
		});
	}

	/* ---------- Formulario de contacto de Divi ----------
	 * <p class="et_pb_contact_field" data-type="input|email|text|select|checkbox|radio">
	 *   <label class="et_pb_contact_form_label">Etiqueta</label> control(es)
	 * </p>
	 * Obligatorio: data-required_mark="required" en el control (o en el
	 * input oculto .et_pb_checkbox_handle de los grupos de casillas).
	 */
	function diviFields(form) {
		var out = [];
		form.querySelectorAll('.et_pb_contact_field').forEach(function (p) {
			var type = p.getAttribute('data-type');
			var labelEl = p.querySelector('.et_pb_contact_form_label');
			var marker = p.querySelector('[data-required_mark]');
			var f = {
				p: p,
				type: type,
				label: clean(labelEl ? labelEl.textContent : p.getAttribute('data-id')),
				required: !!marker && marker.getAttribute('data-required_mark') === 'required'
			};
			if (type === 'checkbox' || type === 'radio') {
				f.options = Array.prototype.slice.call(p.querySelectorAll('input[type=checkbox], input[type=radio]'));
				f.el = f.options[0];
			} else {
				f.el = p.querySelector('input:not([type=hidden]), select, textarea');
			}
			if (f.el) out.push(f);
		});
		return out;
	}

	function diviValue(f) {
		if (f.options) {
			return f.options.filter(function (o) { return o.checked; }).map(function (o) {
				var l = f.p.querySelector('label[for="' + o.id + '"]');
				return clean(l ? l.textContent : o.value);
			}).join(', ');
		}
		return f.el.value.trim();
	}

	function diviError(f) {
		var v = diviValue(f);
		if (!v) return f.required ? 'required' : '';
		if (f.type === 'email' && !EMAIL_RE.test(v)) return 'invalid';
		var pattern = f.el.getAttribute && f.el.getAttribute('pattern');
		if (pattern && !new RegExp('^(?:' + pattern + ')$').test(v)) return 'invalid';
		return '';
	}

	function diviMessage(container, html) {
		var box = container.querySelector('.et-pb-contact-message');
		if (box) box.innerHTML = html;
	}

	function esc(s) {
		var d = document.createElement('div');
		d.textContent = s;
		return d.innerHTML;
	}

	function handleDivi(form) {
		var container = form.closest('.et_pb_contact_form_container') || form.parentNode;
		var fields = diviFields(form);
		var missing = [], invalid = [];
		form.querySelectorAll('.et_contact_error').forEach(function (el) { el.classList.remove('et_contact_error'); });
		fields.forEach(function (f) {
			var err = diviError(f);
			if (!err) return;
			(err === 'required' ? missing : invalid).push(f);
			(f.options || [f.el]).forEach(function (el) { el.classList.add('et_contact_error'); });
		});
		// Captcha de suma de Divi («9 + 6 = __»): en WordPress lo comprobaba el servidor.
		var captcha = form.querySelector('.et_pb_contact_captcha');
		var wrongCaptcha = false;
		if (captcha) {
			var answer = captcha.value.trim();
			var expected = parseInt(captcha.getAttribute('data-first_digit'), 10) +
				parseInt(captcha.getAttribute('data-second_digit'), 10);
			if (!answer) {
				missing.push({ label: 'Captcha', el: captcha });
				captcha.classList.add('et_contact_error');
			} else if (parseInt(answer, 10) !== expected) {
				wrongCaptcha = true;
				captcha.classList.add('et_contact_error');
			}
		}
		if (missing.length || invalid.length || wrongCaptcha) {
			var html = '';
			if (missing.length) {
				html += '<p>Por favor, rellena los siguientes campos:</p><ul>' +
					missing.map(function (f) { return '<li>' + esc(f.label) + '</li>'; }).join('') + '</ul>';
			}
			if (invalid.length) {
				html += '<p>Por favor, corrige los siguientes errores:</p><ul>' +
					invalid.map(function (f) {
						return '<li>' + esc(f.type === 'email' ? MSG.email : f.label + ': ' + (f.el.getAttribute('title') || MSG.pattern)) + '</li>';
					}).join('') + '</ul>';
			}
			if (wrongCaptcha) html += '<p>Has introducido un número equivocado en el captcha.</p>';
			diviMessage(container, html);
			(missing[0] || invalid[0] || { el: captcha }).el.focus();
			return;
		}
		var email = '';
		// Título del propio formulario («Contacto») o, si no tiene, el <h1> de la página.
		var title = container.querySelector('.et_pb_contact_main_title') || document.querySelector('h1');
		var data = {
			formulario: CONFIG.siteName + ' – ' + (clean(title && title.textContent) || document.title),
			pagina: location.href,
			email: '',
			campos: fields.map(function (f) {
				var v = diviValue(f);
				if (f.type === 'email' && !email) email = v;
				return { etiqueta: f.label, valor: v };
			})
		};
		data.email = email;
		var button = form.querySelector('button[type=submit], .et_pb_contact_submit');
		if (button) button.disabled = true;
		diviMessage(container, '');
		send(data).then(function (result) {
			if (button) button.disabled = false;
			if (result === 'mailto') {
				diviMessage(container, '<p>' + esc(MSG.mailto) + '</p>');
				return;
			}
			form.style.display = 'none'; // como Divi: se oculta el formulario y queda el mensaje
			diviMessage(container, '<p>' + esc(MSG.sent) + '</p>');
		}, function (err) {
			if (button) button.disabled = false;
			if (window.console) console.error('[formularios] Error al enviar:', err);
			diviMessage(container, '<p>' + esc(MSG.failed) + '</p>');
		});
	}

	/* ---------- Suscripción a la newsletter (módulo Email Optin de Divi) ----------
	 * En WordPress, Divi la enviaba a Mailchimp con la API key guardada en el
	 * servidor. Aquí se envía como una solicitud más a contactoWeb
	 * («Suscripción a la newsletter»), para darla de alta a mano en Mailchimp.
	 */
	function handleNewsletter(module) {
		var form = module.querySelector('form');
		var fieldsBox = module.querySelector('.et_pb_newsletter_fields');
		var errorBox = module.querySelector('.et_pb_newsletter_error');
		var okBox = module.querySelector('.et_pb_newsletter_success');
		var button = module.querySelector('.et_pb_newsletter_button');
		if (!form || (button && button.getAttribute('aria-busy') === 'true')) return;
		var campos = [], email = '', emailEl = null;
		form.querySelectorAll('.et_pb_newsletter_field').forEach(function (p) {
			var input = p.querySelector('input:not([type=hidden]), textarea, select');
			if (!input) return;
			var label = p.querySelector('label');
			var v = input.type === 'checkbox' ? (input.checked ? 'Sí' : 'No') : input.value.trim();
			if (input.name === 'et_pb_signup_email') { email = v; emailEl = input; }
			campos.push({ etiqueta: clean(label ? label.textContent : input.placeholder || input.name), valor: v });
		});
		form.querySelectorAll('.et_contact_error').forEach(function (el) { el.classList.remove('et_contact_error'); });
		function showError(msg) {
			if (errorBox) { errorBox.textContent = msg; errorBox.style.display = 'block'; }
		}
		if (errorBox) errorBox.style.display = 'none';
		if (!EMAIL_RE.test(email)) {
			if (emailEl) { emailEl.classList.add('et_contact_error'); emailEl.focus(); }
			showError(email ? MSG.email : 'Por favor, introduce tu correo electrónico.');
			return;
		}
		var list = form.querySelector('[name=et_pb_signup_list_id]');
		var provider = form.querySelector('[name=et_pb_signup_provider]');
		if (provider || list) {
			campos.push({ etiqueta: 'Lista', valor: (provider ? provider.value : '') + (list ? ' ' + list.value : '') });
		}
		if (button) { button.setAttribute('aria-busy', 'true'); button.classList.add('et_pb_button_text_loading'); }
		send({
			formulario: CONFIG.siteName + ' – Suscripción a la newsletter',
			pagina: location.href,
			email: email,
			campos: campos
		}).then(function (result) {
			if (result === 'mailto') { showError(MSG.mailto); return; }
			if (fieldsBox) fieldsBox.style.display = 'none';
			if (okBox) okBox.style.display = 'block';
		}, function (err) {
			if (window.console) console.error('[formularios] Error al enviar:', err);
			showError(MSG.failed);
		}).then(function () {
			if (button) { button.removeAttribute('aria-busy'); button.classList.remove('et_pb_button_text_loading'); }
		});
	}

	// Divi escucha el clic en el botón (es un <a href="#">), no el submit.
	window.addEventListener('click', function (e) {
		var btn = e.target.closest && e.target.closest('.et_pb_newsletter_button');
		var module = btn && btn.closest('.et_pb_newsletter');
		if (!module) return;
		e.preventDefault();
		e.stopImmediatePropagation();
		handleNewsletter(module);
	}, true);

	/* ---------- Enganche ----------
	 * Se escucha en fase de captura sobre window para adelantarse a los
	 * manejadores de Contact Form 7 y Divi, que intentarían enviar a WordPress.
	 */
	window.addEventListener('submit', function (e) {
		var form = e.target;
		if (!(form instanceof HTMLFormElement)) return;
		var newsletter = form.closest('.et_pb_newsletter');
		if (newsletter) { // Intro dentro de un campo
			e.preventDefault();
			e.stopImmediatePropagation();
			handleNewsletter(newsletter);
			return;
		}
		if (form.matches('.et_pb_contact_form')) {
			e.preventDefault();
			e.stopImmediatePropagation();
			handleDivi(form);
			return;
		}
		if (!form.matches('.wpcf7-form')) return;
		e.preventDefault();
		e.stopImmediatePropagation();
		// Campo trampa antispam de Akismet: si lo rellena un bot, fingimos éxito.
		var hp = form.querySelector('[name="_wpcf7_ak_hp_textarea"]');
		if (hp && hp.value) {
			cf7Status(form, 'sent', MSG.sent);
			return;
		}
		handleCf7(form);
	}, true);

	// Precarga Firebase y reCAPTCHA al empezar a rellenar un formulario, para
	// que App Check tenga su token listo al enviar (y no cargarlo en cada visita).
	window.addEventListener('focusin', function (e) {
		if (CONFIG.recaptchaSiteKey && e.target.closest && e.target.closest('.wpcf7-form, .et_pb_contact_form, .et_pb_newsletter')) {
			getCallable().catch(function () {});
		}
	});

	// Quita los avisos de error al corregir un campo.
	window.addEventListener('input', clearOne, true);
	window.addEventListener('change', clearOne, true);
	function clearOne(e) {
		var el = e.target;
		if (!el.closest) return;
		if (el.closest('.et_pb_contact_form')) {
			el.classList.remove('et_contact_error'); // captcha (fuera de .et_pb_contact_field)
			var fp = el.closest('.et_pb_contact_field');
			if (fp) fp.querySelectorAll('.et_contact_error').forEach(function (x) { x.classList.remove('et_contact_error'); });
			return;
		}
		if (!el.closest('.wpcf7-form')) return;
		el.classList.remove('wpcf7-not-valid');
		var wrap = el.closest('.wpcf7-form-control-wrap');
		if (wrap) {
			var tip = wrap.querySelector('.wpcf7-not-valid-tip');
			if (tip) tip.remove();
			var ctl = wrap.querySelector('.wpcf7-not-valid');
			if (ctl) ctl.classList.remove('wpcf7-not-valid');
		}
		el.setAttribute('aria-invalid', 'false');
	}
})();
