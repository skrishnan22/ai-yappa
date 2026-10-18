import mermaid from 'mermaid';
import { visualRoot } from './visual.ts';

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });

window.renderVisual = async (source) => {
	// `parse` throws the line-numbered syntax error the model repairs from.
	await mermaid.parse(source);
	const { svg } = await mermaid.render('visual-svg', source);
	visualRoot().innerHTML = svg;
};
