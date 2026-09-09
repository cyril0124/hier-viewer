module semantic_leaf #(parameter int W = 8)
    (input wire [W-1:0] data_i, output wire [W-1:0] data_o);
    assign data_o = data_i;
endmodule

module semantic_wrapper #(parameter int W = 8)
    (input wire [W-1:0] data_i, output wire [W-1:0] data_o);
    for (genvar i = 0; i < 2; ++i) begin : lanes
        wire [W-1:0] local_link;
        semantic_leaf #(W) first(.data_i(data_i), .data_o(local_link));
        if (i == 0) begin : chosen
            semantic_leaf #(W) second(.data_i(local_link), .data_o(data_o));
        end
    end
endmodule

module empty_cell;
endmodule

module bidirectional_cell(inout wire pad, ref logic state);
endmodule

interface semantic_interface;
    logic value;
endinterface

module interface_cell(semantic_interface bus);
endmodule

module semantic_top(input wire [7:0] alpha, beta, input wire select,
                    output wire [7:0] result_a, result_b, output wire [3:0] low,
                    inout wire pad);
    wire [7:0] fanout, expression_result, constant_result, multidriver;
    logic state;
    logic procedural;
    wire [15:0] wide_result;
    wire [7:0] separate_slices;
    wire [7:0] initialized_net = alpha;
    logic initialized_variable = 1'b0;
    assign separate_slices[3:0] = alpha[3:0];
    assign separate_slices[7:4] = beta[7:4];
`ifdef REVERSE_ORDER
    semantic_wrapper second(.data_i(beta), .data_o(result_b));
    semantic_wrapper first(.data_i(alpha), .data_o(result_a));
`else
    semantic_wrapper first(.data_i(alpha), .data_o(result_a));
    semantic_wrapper second(.data_i(beta), .data_o(result_b));
`endif
    semantic_leaf source(.data_i(alpha), .data_o(fanout));
    semantic_leaf sink_a(.data_i(fanout), .data_o());
    semantic_leaf sink_b(.data_i(fanout), .data_o());
    semantic_leaf sliced(.data_i({alpha[3:0], beta[7:4]}), .data_o({low, expression_result[3:0]}));
    semantic_leaf expression_cell(.data_i(select ? alpha ^ beta : ~beta), .data_o(expression_result));
    semantic_leaf constant_cell(.data_i(8'hA5), .data_o(constant_result));
    semantic_leaf #(16) wide(.data_i({alpha, beta}), .data_o(wide_result));
    assign multidriver = alpha;
    assign multidriver = beta;
    assign state = select;
    always_comb procedural = alpha[0];
    bidirectional_cell bidir(.pad(pad), .state(state));
    semantic_interface bus();
    interface_cell interface_user(.bus(bus));
    empty_cell empty();
    wire primitive_out;
    and primitive_gate(primitive_out, alpha[0], beta[0]);
endmodule
