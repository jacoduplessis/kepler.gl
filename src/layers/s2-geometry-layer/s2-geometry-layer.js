// Copyright (c) 2019 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

import memoize from 'lodash.memoize';
import {GeoJsonLayer, S2Layer} from 'deck.gl';
import EnhancedColumnLayer from 'deckgl-layers/column-layer/enhanced-column-layer';
import {hexToRgb} from 'utils/color-utils';

import Layer from '../base-layer';
import S2LayerIcon from './s2-layer-icon';
import {CHANNEL_SCALES, HIGHLIGH_COLOR_3D} from 'constants/default-settings';
import {idToPolygonGeo} from '../h3-hexagon-layer/h3-utils';

const DEFAULT_LINE_SCALE_VALUE = 8;

export const s2RequiredColumns = ['s2_id'];

export const S2_ID_FIELDS = {
  s2_id: ['s2_id', 's2_token']
};

export const S2VisConfigs = {
  opacity: 'opacity',
  colorRange: 'colorRange',
  coverage: 'coverage',
  sizeRange: 'elevationRange',
  coverageRange: 'coverageRange',
  elevationScale: 'elevationScale'
};

export const S2IdAccessor = ({s2_id}) => d => d[s2_id.fieldIdx];
export const S2IdResolver = ({s2_id}) => s2_id.fieldIdx;

export default class S2GeometryLayer extends Layer {

  constructor(props) {
    super(props);
    this.registerVisConfig(S2VisConfigs);
    this.getS2Id = memoize(S2IdAccessor, S2IdResolver);
  }

  get type() {
    return 's2';
  }

  get name() {
    return 'S2'
  }

  get requiredLayerColumns() {
    return s2RequiredColumns;
  }

  get layerIcon() {
    return S2LayerIcon;
  }

  get visualChannels() {
    return {
      ...super.visualChannels,
      size: {
        ...super.visualChannels.size,
        property: 'height'
      },
      coverage: {
        property: 'coverage',
        field: 'coverageField',
        scale: 'coverageScale',
        domain: 'coverageDomain',
        range: 'coverageRange',
        key: 'coverage',
        channelScaleType: CHANNEL_SCALES.radius
      }
    };
  }

  static findDefaultLayerProps({fields = []}) {
    const foundColumns = this.findDefaultColumnField(S2_ID_FIELDS, fields);
    if (!foundColumns || !foundColumns.length) {
      return {props: []};
    }

    return {
      props: foundColumns.map(columns => ({
        isVisible: true,
        label: 'S2',
        columns
      }))
    };
  }

  getDefaultLayerConfig(props = {}) {
    return {
      ...super.getDefaultLayerConfig(props),
      coverageField: null,
      coverageDomain: [0, 1],
      coverageScale: 'linear'
    }
  }

  formatLayerData(_, allData, filteredIndex, oldLayerData, opt = {}) {
    const {
      colorScale,
      colorDomain,
      colorField,
      color,
      columns,
      sizeField,
      sizeScale,
      sizeDomain,
      coverageField,
      coverageScale,
      coverageDomain,
      visConfig: {sizeRange, colorRange, coverageRange}
    } = this.config;

    // color
    const cScale =
      colorField &&
      this.getVisChannelScale(
        colorScale,
        colorDomain,
        colorRange.colors.map(c => hexToRgb(c))
      );

    // height
    const sScale =
      sizeField && this.getVisChannelScale(sizeScale, sizeDomain, sizeRange, 0);

    // coverage
    const coScale =
      coverageField &&
      this.getVisChannelScale(coverageScale, coverageDomain, coverageRange, 0);

    const getS2Id = this.getS2Id(columns);

    if (!oldLayerData || oldLayerData.getS2Id !== getS2Id) {
      this.updateLayerMeta(allData, getS2Id);
    }

    let data;
    if (
      oldLayerData &&
      oldLayerData.data &&
      opt.sameData &&
      oldLayerData.getS2Id === getS2Id
    ) {
      data = oldLayerData.data;
    } else {
      data = filteredIndex.reduce((accu, index, i) => {
        const id = getS2Id(allData[index]);
        const centroid = this.dataToFeature.centroids[index];

        if (centroid) {
          accu.push({
            // keep a reference to the original data index
            index: i,
            data: allData[index],
            id,
            centroid
          });
        }

        return accu;
      }, []);
    }

    const getElevation = sScale
      ? d => this.getEncodedChannelValue(sScale, d.data, sizeField, 0)
      : 0;

    const getColor = cScale
      ? d => this.getEncodedChannelValue(cScale, d.data, colorField)
      : color;

    const getCoverage = coScale
      ? d => this.getEncodedChannelValue(coScale, d.data, coverageField, 0)
      : 1;

    return {
      data,
      getElevation,
      getColor,
      getS2Id,
      getCoverage,
      hexagonVertices: this.dataToFeature.hexagonVertices,
      hexagonCenter: this.dataToFeature.hexagonCenter
    };

  }

  renderLayer({
    data,
    idx,
    layerInteraction,
    objectHovered,
    mapState,
    interactionConfig
  }) {
    const zoomFactor = this.getZoomFactor(mapState);
    const eleZoomFactor = this.getElevationZoomFactor(mapState);
    const {config} = this;
    const {visConfig} = config;

    const s2LayerTriggers = {
      getColor: {
        color: config.color,
        colorField: config.colorField,
        colorRange: config.visConfig.colorRange,
        colorScale: config.colorScale
      },
      getElevation: {
        sizeField: config.sizeField,
        sizeRange: config.visConfig.sizeRange
      }
    };

    const columnLayerTriggers = {
      getCoverage: {
        coverageField: config.coverageField,
        coverageRange: config.visConfig.coverageRange
      }
    };

    return [
      new S2Layer({
        ...layerInteraction,
        ...data,
        id: this.id,
        idx,
        pickable: true,
        getS2Token: x => x.id,

        // coverage
        coverage: config.coverageField ? 1 : visConfig.coverage,

        // parameters
        parameters: {depthTest: Boolean(config.sizeField || mapState.dragRotate)},

        // highlight
        autoHighlight: Boolean(config.sizeField),
        highlightColor: HIGHLIGH_COLOR_3D,

        // elevation
        extruded: Boolean(config.sizeField),
        elevationScale: visConfig.elevationScale * eleZoomFactor,

        // color
        opacity: visConfig.opacity,

        // render
        updateTriggers: s2LayerTriggers,
        _subLayerProps: {
          'cell': {
            type: EnhancedColumnLayer,
            getCoverage: data.getCoverage,
            updateTriggers: columnLayerTriggers
          }
        }
      }),
      ...(this.isLayerHovered(objectHovered) && !config.sizeField
        ? [
          new GeoJsonLayer({
            id: `${this.id}-hovered`,
            data: [idToPolygonGeo(objectHovered)],
            getLineColor: config.highlightColor,
            lineWidthScale: DEFAULT_LINE_SCALE_VALUE * zoomFactor
          })
        ]
        : [])
    ];

  }

}
