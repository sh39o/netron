const xmodel = {};
xmodel.ModelFactory = class {

    match(context) {
        const tags = context.tags('pb');
        if (tags.get(5) === 2) {
            context.type = 'xmodel.pb';
        }
    }

    async open(context) {
        xmodel.proto = await context.require('./xmodel-proto');
        xmodel.proto = xmodel.proto.serial_v2;
        let graph = null;
        try {
            const reader = context.read('protobuf.binary');
            graph = xmodel.proto.Graph.decode(reader);
        } catch (error) {
            const message = error && error.message ? error.message : error.toString();
            throw new xmodel.Error(`File format is not serial_v2.Graph (${message.replace(/\.$/, '')}).`);
        }
        return new xmodel.Model(graph);
    }
};

xmodel.Model = class {

    constructor(graph) {
        this.name = graph.graph_name || '';
        this.format = 'xmodel';
        this.producer = graph && graph.graph_attr && graph.graph_attr.origin && graph.graph_attr.origin.string_value ? graph.graph_attr.origin.string_value : '';
        this.graphs = [new xmodel.Graph(graph)];
    }
};

xmodel.Graph = class {

    constructor(graph) {
        const metadata = new xmodel.Metadata(graph.op_defs);
        this.inputs = [];
        this.outputs = [];
        this.root_subg = graph.subg_root;
        this.groups = new Map();
        this.const_nodes = [];
        this.op_map = new Map();
        const counts = new Map();
        for (const op_node of graph.op_node) {
            for (const arg of op_node.args) {
                for (const arg_op of arg.arg_ops) {
                    counts.set(arg_op, counts.has(arg_op) ? counts.get(arg_op) + 1 : 1);
                }
            }
        }
        const values = new Map();
        values.map = (name, node, initializer) => {
            if (!values.has(name)) {
                values.set(name, new xmodel.Value(name, node, initializer));
            }
            return values.get(name);
        };
        const const_nodes = [];
        const nodes = [];
        for (const node of graph.op_node) {
            if (node.args.length === 0) {
                if (node.op_type === 'data' || node.op_type === 'data-fix') {
                    values.map(node.op_name, node);
                    nodes.push(node);
                    // this.inputs.push(new xmodel.Argument(node.op_name, [ value ]));
                    continue;
                }
            }
            if (node.args.length === 0) {
                if (node.op_type === 'const-fix' || node.op_type === 'const') {
                    values.map(node.op_name, node, true);
                    const_nodes.push(node);
                    continue;
                }
            }
            values.map(node.op_name, node);
            nodes.push(node);
        }
        this.nodes = nodes.map((node) => new xmodel.Node(metadata, node, values));
        this.const_nodes = const_nodes.map((node) => new xmodel.Node(metadata, node, values));

        for (const node of this.nodes.concat(this.const_nodes)) {
            this.op_map.set(node.name, node);
        }

        let subg_name = this.root_subg.subgraph_name;
        if (this.root_subg.subg_child.length > 0) {
            const subg_map = new Map();
            this.set_group(this.root_subg, this, subg_name, subg_map);
            this.build_hierarchy(this.root_subg, subg_map);
        }
    }

    get_node(name) {
        return this.op_map.get(name);
    }

    set_group_subgraph(group_name, subgraph) {
        this.groups.set(group_name, subgraph);
    }

    set_group(subg, graph, subg_name, subg_map) {
        const xmodel_subg = new xmodel.Subgraph(subg);
        subg_map.set(subg, xmodel_subg);
        this.set_group_subgraph(subg_name, xmodel_subg);
        const children = subg.subg_child;
        if (children.length > 0) {
            for (const child of children) {
                const cur_subg_name = subg_name + "/" + child.subgraph_name.replace(/\//g, "_");
                this.set_group(child, graph, cur_subg_name, subg_map);
            }
        } else {
            let ops = subg.op_name;
            var cur_subg_name = subg_name;
            for (const op of ops) {
                const xmodel_op = this.get_node(op);
                xmodel_subg.ops.push(xmodel_op);
                xmodel_op.group = cur_subg_name;
                const substrings = cur_subg_name.split('/');
                let cur = "";
                for (const sub of substrings) {
                    if (cur === '') {
                        cur = sub;
                    } else {
                        cur += '/' + sub;
                    }
                    this.get_node(op).groups.set(cur, graph.groups.get(cur));
                }
            }
        }
    }

    build_hierarchy(subg, subg_map) {
        const children = subg.subg_child;
        const xmodel_subg = subg_map.get(subg);
        if (children.length > 0) {
            for (const child of children) {
                const xmodel_child = subg_map.get(child);
                xmodel_subg.children.push(xmodel_child);
                xmodel_child.parent = xmodel_subg;
                this.build_hierarchy(child, subg_map);
            }
        }
    }
};

xmodel.Subgraph = class {
    constructor(subgraph) {
        this.name = subgraph.subgraph_name;
        this.attributes = [];
        this.parent;
        this.children = [];
        this.ops = [];

        Object.entries(subgraph.subg_attr).forEach(([key, value]) => {
            this.attributes.push(new xmodel.Argument(key, xmodel.Utility.attribute(value)));
        });
    }
}

xmodel.Argument = class {

    constructor(name, value) {
        this.name = name;
        this.value = value;
    }
};

xmodel.Value = class {

    constructor(name, node, initializer) {
        if (typeof name !== 'string') {
            throw new xmodel.Error(`Invalid value identifier '${JSON.stringify(name)}'.`);
        }
        this.name = name;
        if (node) {
            const tensor = node.output_tensor;
            if (tensor) {
                if (initializer) {
                    this.initializer = new xmodel.Tensor(node);
                    this.type = this.initializer.type;
                } else {
                    this.type = new xmodel.TensorType(tensor);
                }
            }
        }
    }
};

xmodel.Node = class {

    constructor(metadata, op_node, values) {
        this.name = op_node.op_name || '';
        this.type = metadata.type(op_node.op_type);
        this.inputs = [];
        this.outputs = [];
        this.attributes = [];
        this.chain = [];
        this.group = "";
        this.groups = new Map();
        if (op_node.op_attr) {
            for (const [name, obj] of Object.entries(op_node.op_attr)) {
                if (name === 'device') {
                    this.device = obj.string_value;
                    continue;
                }
                if (name.startsWith('quant_in_') || name.startsWith('quant_out_')) {
                    continue;
                }
                const value = xmodel.Utility.attribute(obj);
                if (name === "type" && typeof obj.string_value === 'string') {
                  this.chain.unshift(new xmodel.Node(metadata, { op_type: value.value.toLowerCase() }, values));
                }
                if (name === 'nonlinear' && value.value && value.value !== 'NONE' && value.value !== 0) {
                    let activation = value.value;
                    if (typeof activation === 'string') {
                        activation = activation.toLowerCase();
                    } else if (Number.isInteger(activation) && activation < 6) {
                        activation = [ 'none', 'relu', 'prelu', 'leakyrelu', 'relu6', 'sigmoid'][activation];
                    } else {
                        activation = JSON.stringify(activation);
                    }
                    this.chain.push(new xmodel.Node(metadata, { op_type: activation }, values));
                }
                if (name === 'data' && value.value) {
                    var np_value;
                    var data = new Uint8Array(value.value);
                    var data_type_str = op_node.op_attr.data_type.string_value.toUpperCase();
                    switch (data_type_str) {
                        case "XINT8":
                        case "INT8":
                            np_value = new Int8Array(data.buffer);
                            break;
                        case "XINT16":
                        case "INT16":
                            np_value = new Int16Array(data.buffer);
                            break;
                        case "XINT32":
                        case "INT32":
                            np_value = new Int32Array(data.buffer);
                            break;
                        case "XUINT8":
                        case "UINT8":
                            np_value = new Uint8Array(data.buffer);
                            break;
                        case "XUINT16":
                        case "UINT16":
                            np_value = new Uint16Array(data.buffer);
                            break;
                        case "XUINT32":
                        case "UINT32":
                            np_value = new Uint32Array(data.buffer);
                            break;
                        case "XINT64":
                        case "INT64":
                            np_value = new BigInt64Array(data.buffer);
                            break;
                        case "XUINT64":
                        case "INT64":
                            np_value = new BigUint64Array(data.buffer);
                            break;
                        case "FLOAT32":
                            np_value = new Float32Array(data.buffer);
                            break;
                        case "FLOAT64":
                            np_value = new Float64Array(data.buffer);
                            break;
                        case "BFLOAT16":
                            const bfloat16Array = new Uint16Array(data.buffer);
                            np_value = new Float32Array(bfloat16Array.length);
                            for (let i = 0; i < bfloat16Array.length; i++) {
                                np_value[i] = new Float32Array(new Uint16Array([0, bfloat16Array[i]]).buffer)[0];
                            }
                            break;
                        default:
                            break;
                    }
                    this.attributes.push(new xmodel.Attribute(metadata.attribute(this.type, name), name, {"type": "byte[]", "value": np_value}));
                    continue;
                }
                const attribute = new xmodel.Attribute(metadata.attribute(this.type, name), name, value);
                this.attributes.push(attribute);
            }
        }
        if (op_node.args) {
            for (const input of op_node.args) {
                const args = input.arg_ops.map((arg_op) => values.map(arg_op));
                const argument = new xmodel.Argument(input.arg_name, args);
                this.inputs.push(argument);
            }
        }
        if (op_node.op_name) {
            const argument = new xmodel.Argument('output', [values.map(op_node.op_name)]);
            this.outputs.push(argument);
        }
    }
};

xmodel.Attribute = class {

    constructor(metadata, name, attribute) {
        this.name = name;
        this.type = attribute.type;
        this.value = attribute.value;
        if (metadata) {
            if (metadata.default !== undefined) {
                if (metadata.default === this.value) {
                    this.visible = false;
                }
                if (Array.isArray(metadata.default) && Array.isArray(this.value) &&
                    metadata.default.length === this.value.length && metadata.default.every((value, index) => value === this.value[index])) {
                    this.visible = false;
                }
            }
        }
    }
};

xmodel.TensorType = class {
    constructor(tensor) {
        switch (tensor.data_type) {
            case 0: this.dataType = 'int'; break;
            case 1: this.dataType = 'uint'; break;
            case 2: this.dataType = 'xint'; break;
            case 3: this.dataType = 'xuint'; break;
            case 4: this.dataType = 'float'; break;
            case 5: this.dataType = 'bfloat'; break;
            default: this.dataType = 'unknown'; break;
        }
        this.dataType += tensor.tensor_bit_width.toString();
        this.shape = new xmodel.TensorShape(tensor.tensor_dim);
        if (tensor.tensor_attr) {
            const attr = {};
            for (const [key, obj] of Object.entries(tensor.tensor_attr)) {
                const value = obj[obj.value];
                if (key.startsWith('quant_')) {
                    continue;
                }
                attr[key] = value;
            }
            const denotation = [`tensor name: ${tensor.tensor_name}`];
            Object.keys(attr)
              .sort()
              .forEach((key) => {
                let value = attr[key];
                if (
                  typeof value === "object" &&
                  "value" in value &&
                  value.value.length > 0 &&
                  value.value.constructor.name.endsWith("Array")
                ) {
                  value = "[" + value.value.join(",") + "]";
                }
                denotation.push(`${key}: ${value}`);
              });
            this.denotation = '\n' + denotation.join('\n');
        }
    }

    toString() {
        return (this.dataType || '?') + this.shape.toString();
    }
};

xmodel.TensorShape = class {

    constructor(dimensions) {
        this.dimensions = Array.from(dimensions);
    }

    toString() {
        if (!this.dimensions || this.dimensions.length === 0) {
            return '';
        }
        return `[${this.dimensions.map((dimension) => dimension.toString()).join(',')}]`;
    }
};

xmodel.Tensor = class {

    constructor(node) {
        this.name = node.output_tensor.tensor_name;
        this.type = new xmodel.TensorType(node.output_tensor);
        this.category = node.op_type;
        if (node.op_attr && node.op_attr.data) {
            const data = node.op_attr.data;
            if (data.bytes_value && data.bytes_value.value) {
                this.encoding = '<';
                this.values = data.bytes_value.value;
            }
        }
    }
};

xmodel.Utility = class {

    static attribute(attr_value) {
        const key = attr_value.value;
        const type = key.replace(/_value$/, '');
        const value = attr_value[attr_value.value];
        switch (type) {
            case 'bool':
                return { type: 'boolean', value: value };
            case 'int8_t':
                return { type: 'int8', value: value };
            case 'uint8_t':
                return { type: 'uint8', value: value };
            case 'int16_t':
                return { type: 'int16', value: value };
            case 'uint16_t':
                return { type: 'uint16', value: value };
            case 'int32':
            case 'int32_t':
                return { type: 'int32', value: value };
            case 'int32_vec':
            case 'int32_t_vec':
                return { type: 'int32[]', value: value.value };
            case 'uint32':
            case 'uint32_t':
                    return { type: 'uint32', value: value };
            case 'uint32_vec':
            case 'uint32_t_vec':
                return { type: 'uint32[]', value: value.value };
            case 'int8_t_vec':
                return { type: 'int8[]', value: value.value };
            case 'uint8_t_vec':
                return { type: 'uint8[]', value: value.value };
            case 'int16_t_vec':
                return { type: 'int16[]', value: value.value };
            case 'uint16_t_vec':
                return { type: 'uint16[]', value: value.value };
            case 'int64':
            case 'int64_t':
                return { type: 'int64', value: value };
            case 'int64_vec':
            case 'int64_t_vec':
                return { type: 'int64[]', value: value.value};
            case 'uint64':
            case 'uint64_t':
                return { type: 'uint64', value: value };
            case 'uint64_vec':
            case 'uint64_t_vec':
                return { type: 'uint64[]', value: value.value};
            case 'float':
                return { type: 'float32', value: value };
            case 'float_vec':
                return { type: 'float32[]', value: value.value };
            case 'double':
                return { type: 'float64', value: value };
            case 'double_vec':
                return { type: 'float64[]', value: value.value };
            case 'string':
                return { type: 'string', value: value };
            case 'string_vec':
                return { type: 'string[]', value: value.value };
            case 'bytes':
                return { type: 'byte[]', value: value.value };
            case 'map_string_2_int32':
                return { type: 'map<string,int32>', value: value.value };
            case 'map_string_2_string':
                return { type: 'map<string,string>', value: value.value};
            case 'map_string_2_bytes':
                return { type: 'map<string,Bytes>', value: value.value};
            default:
                throw new xmodel.Error("Unsupported attribute type '" + type + "'.");
        }
    }
};

xmodel.Metadata = class {

    constructor(op_defs) {
        this._types = new Map();
        this._attributes = new Map();
        const categories = [
            [ 'avgpool2d', 'Pool' ],
            [ 'batchnorm', 'Normalization' ],
            [ 'instancenorm', 'Normalization' ],
            [ 'instancenorm-fix', 'Normalization' ],
            [ 'celu', 'Activation' ],
            [ 'concat-fix', 'Tensor' ],
            [ 'concat', 'Tensor' ],
            [ 'conv2d-fix', 'Layer' ],
            [ 'qlinear-conv2d', 'Layer'],
            [ 'conv2d', 'Layer' ],
            [ 'conv3d', 'Layer' ],
            [ 'conv3d-fix', 'Layer' ],
            [ 'depthwise-conv2d-fix', 'Layer' ],
            [ 'depthwise-conv2d', 'Layer' ],
            [ 'eltwise-fix', 'Layer' ],
            [ 'add', 'Layer' ],
            [ 'sub', 'Layer' ],
            [ 'mul', 'Layer' ],
            [ 'div', 'Layer' ],
            [ 'min', 'Layer' ],
            [ 'max', 'Layer' ],
            [ 'equal', 'Layer' ],
            [ 'greater', 'Layer' ],
            [ 'greater-equal', 'Layer' ],
            [ 'less', 'Layer' ],
            [ 'less-equal', 'Layer' ],
            [ 'or', 'Layer' ],
            [ 'and', 'Layer' ],
            [ 'qlinear-eltwise', 'Layer' ],
            [ 'elu', 'Activation' ],
            [ 'fix', 'Quantization' ],
            [ 'quantize-linear', 'Quantization'],
            [ 'dequantize-linear', 'Quantization'],
            [ 'fix2float', 'Quantization' ],
            [ 'flatten', 'Shape' ],
            [ 'float2fix', 'Quantization' ],
            [ 'gelu', 'Activation' ],
            [ 'hard-sigmoid', 'Activation' ],
            [ 'hard-sigmoid-fix', 'Activation' ],
            [ 'hard-swish', 'Activation' ],
            [ 'hard-swish-fix', 'Activation' ],
            [ 'hard-tanh', 'Activation' ],
            [ 'qlinear-sigmoid', 'Activation'],
            [ 'identity', 'Control' ],
            [ 'inner-product', 'Layer' ],
            [ 'l2_normalize', 'Normalization' ],
            [ 'leaky-relu', 'Activation' ],
            [ 'leakyrelu', 'Activation' ],
            [ 'maxpool2d', 'Pool' ],
            [ 'pool-fix', 'Pool' ],
            [ 'qlinear-pool', 'Pool' ],
            [ 'relu', 'Activation' ],
            [ 'relu6', 'Activation' ],
            [ 'prelu', 'Activation' ],
            [ 'reshape-fix', 'Shape' ],
            [ 'reshape', 'Shape' ],
            [ 'scale', 'Layer' ],
            [ 'selu', 'Activation' ],
            [ 'shape', 'Shape' ],
            [ 'sigmoid', 'Activation' ],
            [ 'softmax', 'Activation' ],
            [ 'squeeze', 'Transform' ],
            [ 'gstiling', 'Transform' ],
            [ 'tile-fix', 'Transform'],
            [ 'stack', 'Tensor' ],
            [ 'strided_slice', 'Tensor' ],
            [ 'strided_slice-fix', 'Tensor'],
            [ 'swish', 'Activation' ],
            [ 'tanh', 'Activation' ],
            [ 'tanh-fix', 'Activation'],
            [ 'threshold', 'Quantization' ],
            [ 'transpose', 'Tensor' ],
            [ 'transposed-conv2d', 'Layer' ],
            [ 'transposed-conv2d-fix', 'Layer' ],
            [ 'transposed-depthwise-conv2d', 'Layer' ],
            [ 'transposed-depthwise-conv2d-fix', 'Layer' ],
            [ 'upsample-fix', 'Data' ],
            [ 'reduction_mean', 'Layer' ],
            [ 'reduction_mean-fix', 'Layer' ],
            [ 'reduction_product', 'Layer' ],
            [ 'reduction_sum', 'Layer' ],
            [ 'reduction_sum-fix', 'Layer' ],
            [ 'reduction_min', 'Layer' ],
            [ 'reduction_min-fix', 'Layer' ],
            [ 'argmax', 'Layer'],
            [ 'argmax-fix', 'Layer'],
            [ 'argmin', 'Layer'],
            [ 'argmin-fix', 'Layer'],
            [ 'data', 'Data'],
            [ 'data-fix', 'Data']
        ];
        this._types = new Map(categories.map(([name, category]) => [name, { name, category }]));
        for (const op_def of op_defs) {
            const type = this._types.get(op_def.name) || { name: op_def.name };
            if (op_def.annotation) {
                type.description = op_def.annotation;
            }
            type.inputs = op_def.input_args.map((input_arg) => {
                const input = {};
                input.name = input_arg.name;
                if (input_arg.annotation) {
                    input.description = input_arg.annotation;
                }
                return input;
            });
            type.attributes = op_def.attrs.map((attr) => {
                const attribute = {};
                attribute.name = attr.name;
                attribute.default = xmodel.Utility.attribute(attr.default_value).value;
                if (attr.annotation) {
                    attribute.description = attr.annotation;
                }
                return attribute;
            });
            for (const attribute of type.attributes) {
                this._attributes.set(`${type.name}:${attribute.name}`, attribute);
            }
            this._types.set(type.name, type);
        }
    }

    type(name) {
        if (!this._types.has(name)) {
            this._types.set(name, { name });
        }
        return this._types.get(name);
    }

    attribute(type, name) {
        const key = `${type}:${name}`;
        return this._attributes.get(key);
    }
};

xmodel.Error = class extends Error {

    constructor(message) {
        super(message);
        this.name = 'Error loading xmodel.';
    }
};

export const ModelFactory = xmodel.ModelFactory;

