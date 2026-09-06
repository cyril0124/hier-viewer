module parameterized_cell #(parameter int W = 8);
    logic [W-1:0] payload;
    reg [W-1:0] state;
    wire [W-1:0] link;

    for (genvar i = 0; i < W / 8; i++) begin : generated
        logic [1:0] _GENflag;
    end
endmodule

module top;
`ifdef REVERSE_ORDER
    parameterized_cell #(.W(32)) wide_a();
    parameterized_cell #(.W(8)) narrow_a();
    parameterized_cell #(.W(32)) wide_b();
    parameterized_cell #(.W(8)) narrow_b();
    parameterized_cell #(.W(32)) wide_c();
    parameterized_cell #(.W(8)) narrow_c();
`else
    parameterized_cell #(.W(8)) narrow_a();
    parameterized_cell #(.W(32)) wide_a();
    parameterized_cell #(.W(8)) narrow_b();
    parameterized_cell #(.W(32)) wide_b();
    parameterized_cell #(.W(8)) narrow_c();
    parameterized_cell #(.W(32)) wide_c();
`endif
endmodule
