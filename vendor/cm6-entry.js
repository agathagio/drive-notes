// Source of the single CodeMirror 6 bundle the Drive Notes uses.
// It is NOT loaded by the app: the app loads the vendor/codemirror.js generated from here.
// To regenerate it, see vendor/README.md.
//
// The list is handpicked instead of using the basicSetup, which brings line numbers, a fold
// gutter, a search panel, autocompletion, bracket closing, rectangular selection and active line
// highlighting: weight and unwanted behavior on a phone.
// ViewPlugin: what turns [[wikilink]] and [!note] back into plain text is a view plugin, not a
// state field, so that it decorates only the visible window and redoes the work as the parser
// moves on. See the plainLinks comment in app.js.
import { EditorView, ViewPlugin, drawSelection, keymap } from '@codemirror/view';
// Transaction comes for the addToHistory annotation: it is what says that swapping the whole text
// (opening a note) is not an edit by the user and does not enter the undo stack.
//
// Prec: the markdown() installs its Enter in Prec.high (the package's addKeymap), and precedence
// beats position in the extension list. Without the Prec here, the app's Enter never runs.
// Compartment: it is through it that the history() is reconfigured when another note is opened,
// which clears the undo stack. Without clearing it, an event from the previous note is remapped by
// the new document and undo pastes a piece of the old note into the one just opened.
import { StateField, StateEffect, Transaction, Prec, Compartment } from '@codemirror/state';
import { Decoration } from '@codemirror/view';
import { history, undo, redo, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage, insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
// The link list ([[ opens the vault's note names). Only the completion itself: closeBrackets and the
// rest of the package stay out, they change how typing behaves everywhere and not just in the link.
// tooltips: the list floats above the keyboard only with position 'fixed' and the body as parent.
import { autocompletion, startCompletion, closeCompletion, acceptCompletion, completionStatus, currentCompletions } from '@codemirror/autocomplete';
import { tooltips } from '@codemirror/view';

window.CM6 = {
  EditorView, ViewPlugin, StateField, StateEffect, Transaction, Prec, Compartment,
  Decoration, keymap, drawSelection,
  history, undo, redo, defaultKeymap, historyKeymap,
  markdown, markdownLanguage, insertNewlineContinueMarkupCommand,
  syntaxHighlighting, HighlightStyle, syntaxTree,
  tags,
  autocompletion, startCompletion, closeCompletion, acceptCompletion, completionStatus, currentCompletions,
  tooltips,
  lineWrapping: EditorView.lineWrapping,
};
