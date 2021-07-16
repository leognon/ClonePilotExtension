const vscode = require('vscode');
const axios = require('axios');
const {
	URLSearchParams
} = require('url');
const beautify = require('js-beautify');
const beautifyOptions = {
	indent_size: 4
}

function activate(context) {
	let selectedEditor; //The editor to insert the completion into
	let selectedRange; //The range to insert the completion into

	//A command to open the ClonePilot window
	context.subscriptions.push(vscode.commands.registerCommand('clone-pilot.openClonePilot', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showInformationMessage('Please open an editor to use ClonePilot.');
			return;
		}

		const document = editor.document;
		let selection = editor.selection;

		if (editor.selection.isEmpty) { //If nothing is highlited, get the word at the cursor
			const cursorWordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
			if (!cursorWordRange) {
				vscode.window.showInformationMessage('Please select or place your cursor on a word to use ClonePilot');
				return; //Cursor not on a word
			}

			selection = new vscode.Selection(cursorWordRange.start.line, cursorWordRange.start.character, cursorWordRange.end.line, cursorWordRange.end.character);
		}

		selectedEditor = editor; //Save to be used when the completion is inserted
		selectedRange = selection;

		const word = document.getText(selection); //The word in the selection
		await openClonePilot(word);

	}));

	const myScheme = 'clonePilot';
	const textDocumentProvider = new class { //Provides a text document for the window
		async provideTextDocumentContent(uri) {
			const params = new URLSearchParams(uri.query);
			const word = params.get('word');
			if (params.get('loading') === 'true') {
				return `/* Clone Pilot is searching for functions for ${word} */\n`;
			}

			try {
				const response = await axios.get(`https://clone-pilot.herokuapp.com/getFunction/${word}`); //Get the functions for that word
				const fns = response.data.sort((a, b) => b.postScore - a.postScore); //Show the highest score first
				const content = getClonePilotText(fns, word);
				return content;
			} catch (err) {
				console.log('Error sending request', err);
				return 'There was an error sending the request\n' + err;
			}
		}
	}();
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(myScheme, textDocumentProvider));

	//Open the ClonePilot window to display the functions
	const openClonePilot = async (word) => {
		//A uri to send to the document
		let loadingUri = vscode.Uri.parse(`${myScheme}:Clone Pilot?word=${word}&loading=true`, true);
		await showUri(loadingUri); //Open a loading window
		let uri = vscode.Uri.parse(`${myScheme}:Clone Pilot?word=${word}&loading=false`, true);
		//TODO If the uri has already been loaded, the codelense breaks
		await showUri(uri); //Show the actual content, once got from the server
	}

	const showUri = async (uri) => {
		const doc = await vscode.workspace.openTextDocument(uri); //Calls back into the provider
		await vscode.window.showTextDocument(doc, {
			viewColumn: vscode.ViewColumn.Beside,
			preview: true, //Don't replace the current window
			preserveFocus: true,
		});
		vscode.languages.setTextDocumentLanguage(doc, 'javascript'); //Enables syntax highlighting
	}

	const getClonePilotText = (fns, word) => {
		codelensProvider.clearPositions(); //Reset the codelens
		let content = `/* Clone Pilot found ${fns.length} functions for ${word} */\n\n`;
		for (let i = 0; i < fns.length; i++) {
			const lineNum = content.split('\n').length; //The line to insert the codelens on
			const formattedFn = formatFunction(fns[i]);
			codelensProvider.addPosition(lineNum, fns[i]); //Add a codelens on that line
			const fnStr = beautify(formattedFn.keywords + formattedFn.header + formattedFn.body, beautifyOptions);
			content += formattedFn.postHeader + fnStr; //Display the entire function in the ClonePilot window
			if (i < fns.length - 1) content += '\n\n';
		}
		return content;
	}

	const formatFunction = fn => {
		const postHeader = `//===== From https://stackoverflow.com/q/${fn.postId} =====\n`;
		if (fn.fnType == 'FunctionDeclaration' || fn.fnType == 'MethodDefinition') {
			const keywords = (fn.fnIsAsync ? 'async ' : '') + 'function '; //TODO Insert the async keyword if function is not already async
			const header = fn.fnName + '(' + fn.fnParams.replace(/,/g, ', ') + ') '; //TODO Make the inserted function type match the chosen function type
			const body = fn.fnBody;

			return {
				postHeader,
				keywords,
				header,
				body
			}
		} else if (fn.fnType == 'ArrowFunctionExpression' || fn.fnType == 'FunctionExpression') {
			// const name = async (params) => { body }
			const keywords = 'const ';
			const header = `${fn.fnName} = ${fn.fnIsAsync ? 'async ' : ''}(${fn.fnParams.replace(/,/g, ', ')}) => `;
			const body = `${fn.fnBody}`;

			return {
				postHeader,
				keywords,
				header,
				body
			}
		}
	}

	//When the user clicks on a codelens for a function
	context.subscriptions.push(vscode.commands.registerCommand('clone-pilot.chooseOption', fn => {
		if (!selectedEditor) return;
		try {
			selectedEditor.edit(editBuilder => {
				const formatted = formatFunction(fn);
				editBuilder.replace(selectedRange, beautify(formatted.header + formatted.body, beautifyOptions)); //Insert the function into the text
			});
			//Close the ClonePilot window. The hide function is deprecated, so it must be shown then closed as the active editor.
			vscode.window.showTextDocument(myScheme, {
					preview: true,
					preserveFocus: false
				})
				.then(() => {
					return vscode.commands.executeCommand('workbench.action.closeActiveEditor');
				});
		} catch (e) {
			//The editor isn't open
		}
	}));

	const codelensProvider = new class { //Keeps track of and provides codelenses
		constructor() {
			this.codelenses = [];
		}
		addPosition(lineNum, fn) {
			const range = new vscode.Range(lineNum, 0, lineNum, 0); //Display it on that line
			this.codelenses.push(new vscode.CodeLens(range, {
				title: 'Use function',
				command: 'clone-pilot.chooseOption',
				arguments: [
					fn
				],
				tooltip: 'Insert this function into your code'
			}));
		}
		clearPositions() {
			this.codelenses = [];
		}

		provideCodeLenses(document) {
			return this.codelenses;
		}

		//TODO Use resolveCodeLens() instead of making the command in addPosition?
	}();
	context.subscriptions.push(vscode.languages.registerCodeLensProvider({
		scheme: myScheme //Only adds codelens to ClonePilot windows
	}, codelensProvider));
}

function deactivate() {}

module.exports = {
	activate,
	deactivate
}