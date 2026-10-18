import * as echarts from 'echarts';
import { parseJsonObject, visualRoot } from './visual.ts';

const DEFAULT_WIDTH = 960;

const DEFAULT_HEIGHT = 540;

window.renderVisual = async (source) => {
	const option = parseJsonObject(source, 'ECharts options');

	const root = visualRoot();
	root.style.width = `${DEFAULT_WIDTH}px`;
	root.style.height = `${DEFAULT_HEIGHT}px`;
	const chart = echarts.init(root, undefined, { renderer: 'svg' });

	await new Promise<void>((resolve, reject) => {
		chart.on('finished', () => resolve());

		try {
			chart.setOption({ ...option, animation: false });
		} catch (error) {
			reject(error);
		}
	});
};
