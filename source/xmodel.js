var xmodel = {};
var protobuf = require('./protobuf');

xmodel.ModelFactory = class {

    match(context) {
        const tags = context.tags('pb');
        if (tags.get(5) === 2) {
            return 'xmodel.pb';
        }
        return undefined;
    }

    async open(context) {
        await context.require('./xmodel-proto');
        let graph = null;
        try {
            xmodel.proto = protobuf.get('xmodel').serial_v2;
            const stream = context.stream;
            const reader = protobuf.BinaryReader.open(stream);
            graph = xmodel.proto.Graph.decode(reader);
        } catch (error) {
            const message = error && error.message ? error.message : error.toString();
            throw new xmodel.Error('File format is not serial_v2.Graph (' + message.replace(/\.$/, '') + ').');
        }
        return new xmodel.Model(graph);
    }
};

xmodel.Subgraph = class {
    constructor(subgraph) {
        this._name = subgraph.subgraph_name;
        this._attributes = [];

        Object.entries(subgraph.subg_attr).forEach(([key, value]) => {
            this._attributes.push(new xmodel.Argument(key, xmodel.Utility.attribute(value)));
        });
    }

    get name() {
        this._name;
    }
}

xmodel.Model = class {

    constructor(graph) {
        this._name = graph.graph_name || '';
        this._format = 'xmodel';
        this._producer = graph && graph.graph_attr && graph.graph_attr.origin && graph.graph_attr.origin.string_value ? graph.graph_attr.origin.string_value : '';
        this._graphs = [ new xmodel.Graph(graph) ];
    }

    get name() {
        return this._name;
    }

    get format() {
        return this._format;
    }

    get producer() {
        return this._producer;
    }

    get graphs() {
        return this._graphs;
    }
};

xmodel.Graph = class {

    constructor(graph) {
        const metadata = new xmodel.Metadata(graph.op_defs);
        this._inputs = [];
        this._outputs = [];
        this._root_subg = graph.subg_root;
        this._subgs = new Map();
        const counts = new Map();
        for (const op_node of graph.op_node) {
            for (const arg of op_node.args) {
                for (const arg_op of arg.arg_ops) {
                    counts.set(arg_op, counts.has(arg_op) ? counts.get(arg_op) + 1 : 1);
                }
            }
        }
        const args = new Map();
        const arg = (name, node, initializer) => {
            if (!args.has(name)) {
                args.set(name, new xmodel.Value(name, node, initializer));
            }
            return args.get(name);
        };
        const nodes = [];
        for (const node of graph.op_node) {
            if (node.args.length === 0) {
                if (node.op_type === 'data' || node.op_type === 'data-fix') {
                    const value = arg(node.op_name, node);
                    this._inputs.push(new xmodel.Argument(node.op_name, [ value ]));
                    continue;
                }
            }
            if (node.args.length === 0 && counts.get(node.op_name) === 1) {
                if (node.op_type === 'const' || node.op_type === 'const-fix') {
                    arg(node.op_name, node, true);
                    continue;
                }
            }
            arg(node.op_name, node);
            nodes.push(node);
        }
        this._nodes = nodes.map((node) => new xmodel.Node(metadata, node, arg));

        // var leafs = [];
        // get_leafs(this._root_subg, leafs);

        // var idx = 0;
        // for (const leaf of leafs) {
        //     let dpus = leaf.op_name;
        //     for (const dpu of dpus) {
        //         var meta = this.get_node(dpu)._metadata;
        //         var category = meta.category;
        //         if (category == "DPU")
        //             category += (idx % 6).toString();
        //         this.get_node(dpu)._metadata.set_category(category);
        //     }
        //     idx++;
        // }
    }

    get inputs() {
        return this._inputs;
    }

    set_group_subgraph(group_name, subgraph) {
        this._subgs.set(group_name, subgraph);
    }

    get outputs() {
        return this._outputs;
    }

    get nodes() {
        return this._nodes;
    }

    get subgs() {
        return this._subgs;
    }

    get root() {
        return this._root_subg;
    }
};



xmodel.Argument = class {

    constructor(name, value) {
        this._name = name;
        this._value = value;
    }

    get name() {
        return this._name;
    }

    get value() {
        return this._value;
    }
};

xmodel.Value = class {

    constructor(name, node, initializer) {
        if (typeof name !== 'string') {
            throw new xmodel.Error("Invalid value identifier '" + JSON.stringify(name) + "'.");
        }
        this._name = name;
        if (node) {
            const tensor = node.output_tensor;
            if (tensor && tensor.tensor_attr && tensor.data_type) {
                if (initializer) {
                    this._initializer = new xmodel.Tensor(node);
                } else {
                    this._type = new xmodel.TensorType(tensor);
                }
            }
        }
    }

    get name() {
        return this._name;
    }

    get type() {
        if (this._initializer) {
            return this._initializer.type;
        }
        return this._type;
    }

    get initializer() {
        return this._initializer;
    }
};

function set_group(subg, graph, subg_name) {
    graph.set_group_subgraph(subg_name, new xmodel.Subgraph(subg));
    var childs = root.subg_child;
    if (childs.length > 0) {
        for (const child of childs) {
            var cur_subg_name = subg_name;
            cur_subg_name += "/" + child.subgraph_name.replace(/\//g, "_");
            set_group(child, graph, cur_subg_name);
        }
    } else {
        let ops = subg.op_name;
        var cur_subg_name = subg_name;
        for (const op of ops) {
            graph._nodes = cur_subg_name;
        }
    }
}

function get_leafs(root, leafs) {
    var childs = root.subg_child_;
    if (childs.length > 0) {
        for (const child of childs) {
            get_leafs(child, leafs);
        }
    } else {
        leafs.push(root);
    }
}

xmodel.Node = class {

    constructor(metadata, op_node, arg) {
        this._name = op_node.op_name || '';
        this._type = metadata.type(op_node.op_type);
        this._inputs = [];
        this._outputs = [];
        this._attributes = [];
        this._chain = [];
        if (op_node.op_attr) {
            for (const entry of Object.entries(op_node.op_attr)) {
                const name = entry[0];
                if (name === 'device') {
                    this._device = entry[1].string_value;
                    continue;
                }
                if (name === 'workload') {
                    continue;
                }
                if (name.startsWith('quant_in_') || name.startsWith('quant_out_')) {
                    continue;
                }
                const value = xmodel.Utility.attribute(entry[1]);
                if (name === 'nonlinear' && value.value && value.value !== 'NONE' && value.value !== 0) {
                    let activation = value.value;
                    if (typeof activation === 'string') {
                        activation = activation.toLowerCase();
                    } else if (Number.isInteger(activation) && activation < 5) {
                        activation = [ 'none', 'relu', 'prelu', 'leakyrelu', 'relu6' ][activation];
                    } else {
                        activation = JSON.stringify(activation);
                    }
                    this._chain.push(new xmodel.Node(metadata, { op_type: activation }, arg));
                    continue;
                }
                // if (name === 'data' && value.value) {
                //     var np_value;
                //     var data = new Uint8Array(value.value);
                //     var data_type_str = op_node.op_attr.data_type.string_value.toUpperCase();
                //     switch (data_type_str) {
                //         case "XINT8":
                //         case "INT8":
                //             np_value = new Int8Array(data.buffer);
                //             break;
                //         case "XINT16":
                //         case "INT16":
                //             np_value = new Int16Array(data.buffer);
                //             break;
                //         case "XINT32":
                //         case "INT32":
                //             np_value = new Int32Array(data.buffer);
                //             break;
                //         case "XUINT8":
                //         case "UINT8":
                //             np_value = new Uint8Array(data.buffer);
                //             break;
                //         case "XUINT16":
                //         case "UINT16":
                //             np_value = new Uint16Array(data.buffer);
                //             break;
                //         case "XUINT32":
                //         case "UINT32":
                //             np_value = new Uint32Array(data.buffer);
                //             break;
                //         case "FLOAT32":
                //             np_value = new Float32Array(data.buffer);
                //             break;
                //         case "FLOAT64":
                //             np_value = new Float64Array(data.buffer);
                //             break;
                //         default:
                //             break;
                //     }
                //     continue;
                // }
                this._attributes.push(new xmodel.Attribute(metadata.attribute(this._type, name), name, value));
            }
        }
        if (op_node.args) {
            for (const input of op_node.args) {
                const args = input.arg_ops.map((arg_op) => arg(arg_op));
                this._inputs.push(new xmodel.Argument(input.arg_name, args));
            }
        }
        if (op_node.op_name) {
            this._outputs.push(new xmodel.Argument('output', [ arg(op_node.op_name) ]));
        }
    }

    get type() {
        return this._type;
    }

    get name() {
        return this._name;
    }

    get device() {
        return this._device;
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }

    get attributes() {
        return this._attributes;
    }

    get chain() {
        return this._chain;
    }
};

xmodel.Attribute = class {

    constructor(metadata, name, attribute) {
        this._name = name;
        this._type = attribute.type;
        this._value = attribute.value;
        if (metadata) {
            if (metadata.default !== undefined) {
                if (metadata.default === this._value) {
                    this._visible = false;
                }
                if (Array.isArray(metadata.default) && Array.isArray(this._value) &&
                    metadata.default.length === this._value.length && metadata.default.every((value, index) => value === this._value[index])) {
                    this._visible = false;
                }
            }
        }
    }

    get name() {
        return this._name;
    }

    get type() {
        return this._type;
    }

    get value() {
        return this._value;
    }

    get visible() {
        return this._visible == false ? false : true;
    }
};

xmodel.TensorType = class {
    constructor(tensor) {
        switch (tensor.data_type) {
            case 0: this._dataType = 'int'; break;
            case 1: this._dataType = 'uint'; break;
            case 2: this._dataType = 'xint'; break;
            case 3: this._dataType = 'xuint'; break;
            case 4: this._dataType = 'float'; break;
            default: throw new xmodel.Error('...');
        }
        this._dataType += tensor.tensor_bit_width.toString();
        this._shape = new xmodel.TensorShape(tensor.tensor_dim);
        if (tensor.tensor_attr) {
            const attr = {};
            for (const entry of Object.entries(tensor.tensor_attr)) {
                const key = entry[0];
                const value = entry[1];
                if (key.startsWith('quant_')) {
                    continue;
                }
                attr[key] = value;
            }
            const denotation = [];
            for (const [key, value] of Object.entries(attr)) {
                denotation.push(`${key}: ${xmodel.Utility.attribute(value).value}`);
            }
            this._denotation = denotation.join(', \n');
        }
    }

    get dataType() {
        return this._dataType;
    }

    get shape() {
        return this._shape;
    }

    get denotation() {
        return this._denotation;
    }

    toString() {
        return (this.dataType || '?') + this._shape.toString();
    }
};

xmodel.TensorShape = class {

    constructor(dimensions) {
        this._dimensions = Array.from(dimensions);
    }

    get dimensions() {
        return this._dimensions;
    }

    toString() {
        if (!this._dimensions || this._dimensions.length == 0) {
            return '';
        }
        return '[' + this._dimensions.map((dimension) => dimension.toString()).join(',') + ']';
    }
};

xmodel.Tensor = class {

    constructor(node) {
        this._type = new xmodel.TensorType(node.output_tensor);
        this._category = node.op_type;
        this._name = node.output_tensor.tensor_name;
        if (this._category == "const" || this._category == "const-fix") {
            var data_value = xmodel.Utility.attribute(node.op_attr.data);
            var np_value = [];
            var data = new Uint8Array(data_value.value);
            var data_type = node.op_attr.data_type.string_value.toUpperCase();
            switch (data_type) {
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
                case "FLOAT32":
                    np_value = new Float32Array(data.buffer);
                    break;
                case "FLOAT64":
                    np_value = new Float64Array(data.buffer);
                    break;
                default:
                    break;
            }
            this.values = np_value;
        }
    }

    get name() {
        return this._name;
    }

    get category() {
        return this._category;
    }

    get type() {
        return this._type;
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
                return { type: 'int32', value: value };
            case 'int32_vec':
                return { type: 'int32[]', value: value.value };
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
                return { type: 'int64', value: value };
            case 'uint64':
                return { type: 'uint64', value: value };
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
                return { type: 'map<string, string>', value: value.value};
            default:
                throw new xmodel.Error("Unsupported attribute type '" + type + "'.");
        }
    }
};

xmodel.Metadata = class {

    constructor(op_defs) {
        this._types = new Map();
        this._attributes = new Map();
        const categories = new Map([
            [ 'const', 'Data'],
            [ 'const-fix', 'Data'],
            [ 'avgpool2d', 'Pool' ],
            [ 'batchnorm', 'Normalization' ],
            [ 'celu', 'Activation' ],
            [ 'concat-fix', 'Tensor' ],
            [ 'concat', 'Tensor' ],
            [ 'conv2d-fix', 'Layer' ],
            [ 'conv2d', 'Layer' ],
            [ 'depthwise-conv2d-fix', 'Layer' ],
            [ 'depthwise-conv2d', 'Layer' ],
            [ 'elu', 'Activation' ],
            [ 'fix', 'Quantization' ],
            [ 'fix2float', 'Quantization' ],
            [ 'flatten', 'Shape' ],
            [ 'float2fix', 'Quantization' ],
            [ 'gelu', 'Activation' ],
            [ 'hard-sigmoid', 'Activation' ],
            [ 'hard-sigmoid-fix', 'Activation' ],
            [ 'hard-swish', 'Activation' ],
            [ 'hard-tanh', 'Activation' ],
            [ 'identity', 'Control' ],
            [ 'inner-product', 'Layer' ],
            [ 'l2_normalize', 'Normalization' ],
            [ 'leaky-relu', 'Activation' ],
            [ 'leakyrelu', 'Activation' ],
            [ 'maxpool2d', 'Pool' ],
            [ 'pool-fix', 'Pool' ],
            [ 'relu', 'Activation' ],
            [ 'relu6', 'Activation' ],
            [ 'reshape-fix', 'Shape' ],
            [ 'reshape', 'Shape' ],
            [ 'scale', 'Layer' ],
            [ 'selu', 'Activation' ],
            [ 'shape', 'Shape' ],
            [ 'sigmoid', 'Activation' ],
            [ 'softmax', 'Activation' ],
            [ 'squeeze', 'Transform' ],
            [ 'stack', 'Tensor' ],
            [ 'strided_slice', 'Tensor' ],
            [ 'strided_slice-fix', 'Tensor'],
            [ 'swish', 'Activation' ],
            [ 'tanh', 'Activation' ],
            [ 'threshold', 'Quantization' ],
            [ 'transpose', 'Tensor' ],
            [ 'transposed-conv2d', 'Layer' ],
            [ 'transposed-conv2d-fix', 'Layer' ],
            [ 'transposed-depthwise-conv2d', 'Layer' ],
            [ 'transposed-depthwise-conv2d-fix', 'Layer' ],
            [ 'upsample-fix', 'Data' ],
        ]);
        for (const op_def of op_defs) {
            const name = op_def.name;
            const metadata = {};
            metadata.name = name;
            if (op_def.annotation) {
                metadata.description = op_def.annotation;
            }
            metadata.inputs = op_def.input_args.map((input_arg) => {
                const input = {};
                input.name = input_arg.name;
                if (input_arg.annotation) {
                    input.description = input_arg.annotation;
                }
                return input;
            });
            metadata.attributes = op_def.attrs.map((attr) => {
                const attribute = {};
                attribute.name = attr.name;
                const value = xmodel.Utility.attribute(attr.default_value);
                attribute.default = value.value;
                if (attr.annotation) {
                    attribute.description = attr.annotation;
                }
                this._attributes.set(name + ':' + attr.name, attribute);
                return attribute;
            });
            if (categories.has(name)) {
                metadata.category = categories.get(name);
            }
            this._types.set(name, metadata);
        }
        for (const entry of categories) {
            const name = entry[0];
            const category = entry[1];
            if (!this._types.has(name)) {
                this._types.set(name, { name: name, category: category });
            }
        }
    }

    type(name) {
        if (!this._types.has(name)) {
            this._types.set(name, { name: name });
        }
        return this._types.get(name);
    }

    attribute(type, name) {
        const key = type + ':' + name;
        return this._attributes.get(key);
    }
};

xmodel.Error = class extends Error {

    constructor(message) {
        super(message);
        this.name = 'Error loading xmodel.';
    }
};

if (typeof module !== 'undefined' && typeof module.exports === 'object') {
    module.exports.ModelFactory = xmodel.ModelFactory;
}
