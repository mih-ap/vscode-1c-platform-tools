import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runInNewContext } from 'node:vm';
import { requestSaveInActiveForm, SAVE_REQUEST_MESSAGE } from '../../features/editors/formPanels';
import {
	PROPERTY_PALETTE_FOCUSED,
	PROPERTY_PALETTE_VIEW_ID,
	PropertyPaletteViewProvider,
} from '../../features/properties/propertyPaletteView';

/** Панель-заглушка: запоминает сообщения странице и даёт закрыть её. */
function fakeView(): {
	view: vscode.WebviewView;
	posted: unknown[];
	receive: (message: unknown) => void;
	dispose: () => void;
} {
	const posted: unknown[] = [];
	let handler: (message: unknown) => void = () => undefined;
	let onDispose: () => void = () => undefined;
	const webview = {
		options: {},
		html: '',
		postMessage: (message: unknown) => {
			posted.push(message);
			return Promise.resolve(true);
		},
		onDidReceiveMessage: (listener: (message: unknown) => void) => {
			handler = listener;
			return { dispose: () => undefined };
		},
	};
	const view = {
		webview,
		onDidChangeVisibility: () => ({ dispose: () => undefined }),
		onDidDispose: (listener: () => void) => {
			onDispose = listener;
			return { dispose: () => undefined };
		},
	} as unknown as vscode.WebviewView;
	return {
		view,
		posted,
		receive: (message) => handler(message),
		dispose: () => onDispose(),
	};
}

suite('панель свойств: запись по Ctrl+S', () => {
	test('скрипт страницы показывает свойства, записывает правки и вызывает действие события', () => {
		const provider = new PropertyPaletteViewProvider(vscode.Uri.file('/ext'));
		const { view, dispose } = fakeView();
		provider.resolveWebviewView(view);
		try {
			class Element {
				children: Element[] = [];
				textContent = '';
				className = '';
				value = '';
				disabled = false;
				classList = { toggle: () => undefined, add: () => undefined, remove: () => undefined };
				listeners: Record<string, () => void> = {};
				append(child: Element): void { this.children.push(child); }
				addEventListener(name: string, listener: () => void): void { this.listeners[name] = listener; }
				querySelectorAll(selector: string): Element[] {
					return this.children.flatMap((child) => [
						...(child.className === selector.slice(1) ? [child] : []),
						...child.querySelectorAll(selector),
					]);
				}
			}
			const elements = new Map<string, Element>();
			const messages: Array<{ type: string; edits?: Record<string, string>; actionId?: string }> = [];
			let receive: (event: { data: unknown }) => void = () => undefined;
			const script = /<script>([\s\S]*?)<\/script>/.exec(view.webview.html)?.[1];
			assert.ok(script);
			runInNewContext(script, {
				HTMLButtonElement: Element,
				acquireVsCodeApi: () => ({ postMessage: (message: typeof messages[number]) => messages.push(message) }),
				document: {
					getElementById: (id: string) => {
						if (!elements.has(id)) { elements.set(id, new Element()); }
						return elements.get(id);
					},
					createElement: () => new Element(),
				},
				window: { addEventListener: (name: string, listener: typeof receive) => {
					if (name === 'message') { receive = listener; }
				} },
			});
			assert.strictEqual(messages[0].type, 'ready');
			receive({ data: { type: 'state', editable: true, state: {
				title: 'Код', groups: [{ title: 'Основные', rows: [
					{ key: 'Title', label: 'Заголовок', kind: 'text', value: 'Код' },
					{ key: 'event.add', label: 'Событие', kind: 'text', readonly: true,
						action: { id: 'event.add', label: 'Добавить' } },
				] }],
			} } });
			const list = elements.get('list')!;
			assert.strictEqual(elements.get('header')!.children[0].textContent, 'Код');
			const action = list.querySelectorAll('.row-action')[0];
			const input = list.children[1].children[1].children[0];
			input.value = 'Новый код';
			input.listeners.change();
			assert.strictEqual(action.disabled, true);
			elements.get('saveBtn')!.listeners.click();
			assert.strictEqual(messages.at(-1)?.type, 'apply');
			assert.strictEqual(messages.at(-1)?.edits?.Title, 'Новый код');
			// После сброса черновика действие снова доступно.
			receive({ data: { type: 'applied', ok: true } });
			const buttons = list.querySelectorAll('.row-action');
			const latestAction = buttons[buttons.length - 1];
			assert.strictEqual(latestAction.disabled, false);
			(latestAction.listeners.click as (event: { stopPropagation: () => void }) => void)({ stopPropagation: () => undefined });
			assert.strictEqual(messages.at(-1)?.actionId, 'event.add');
		} finally {
			dispose();
		}
	});
	test('пока панель в фокусе, общее сохранение пишет в неё', () => {
		const provider = new PropertyPaletteViewProvider(vscode.Uri.file('/ext'));
		const { view, posted, receive, dispose } = fakeView();
		provider.resolveWebviewView(view);
		try {
			receive({ type: 'focus' });
			posted.length = 0;

			requestSaveInActiveForm();

			assert.deepStrictEqual(posted, [SAVE_REQUEST_MESSAGE]);
		} finally {
			dispose();
		}
	});

	test('без фокуса панели общее сохранение её не трогает', () => {
		const provider = new PropertyPaletteViewProvider(vscode.Uri.file('/ext'));
		const { view, posted, dispose } = fakeView();
		provider.resolveWebviewView(view);
		try {
			posted.length = 0;

			requestSaveInActiveForm();

			assert.deepStrictEqual(posted, []);
		} finally {
			dispose();
		}
	});

	test('страница пишет так же, как редактор свойств во вкладке', () => {
		const provider = new PropertyPaletteViewProvider(vscode.Uri.file('/ext'));
		const { view, dispose } = fakeView();
		provider.resolveWebviewView(view);
		try {
			assert.ok(view.webview.html.includes("message.type === 'saveRequested'"));
			assert.ok(view.webview.html.includes('active.blur()'));
			assert.ok(view.webview.html.includes('saveBtn.click()'));
		} finally {
			dispose();
		}
	});

	test('Ctrl+S панели свойств идёт той же командой, что и у вкладки', () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')
		) as {
			contributes: {
				commands: Array<{ command: string }>;
				keybindings: Array<{ command: string; key: string; when?: string }>;
			};
		};
		const binding = pkg.contributes.keybindings.find(
			(item) => item.command === '1c-platform-tools.editors.save'
		);

		assert.ok(binding, 'сочетание сохранения не объявлено');
		assert.strictEqual(binding.key, 'ctrl+s');
		assert.ok(binding.when?.includes(PROPERTY_PALETTE_VIEW_ID));
		assert.ok(binding.when?.includes(PROPERTY_PALETTE_FOCUSED));
		assert.ok(binding.when?.includes('1cMetadataObjectProperties'));
		assert.ok(binding.when?.includes('1cClusterObjectProperties'));
		assert.ok(binding.when?.includes('1cClusterAdminProperties'));
		assert.ok(binding.when?.includes('1cClusterConnections'));
		assert.ok(
			!pkg.contributes.commands.some((item) => item.command === '1c-platform-tools.properties.save')
		);
	});
});
