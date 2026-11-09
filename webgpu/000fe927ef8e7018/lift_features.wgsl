fn flag(v:bool)->f32{return select(0.0,1.0,v);}
fn x(row:i32,index:i32)->f32{return inputs[u32(row*544+index)];}
fn features(row:i32,choice:i32)->array<f32,256>{
var f:array<f32,256>;
var floors = max(i32(2), i32(f32(x(row, 26)) * 30 + 0.5));
var top = f32(floors - 1);
var currentTarget = i32(f32(x(row, 33)) * top + 0.5);
var base = i32(30);
for(var a:i32=0;a<i32(31);a++){
if(x(row, 484 + a) != 0){
base = a;
}
}
var command = choice;
if(choice == 31){
command = base;
}
var floor = command;
if(command == 30){
floor = currentTarget;
}
floor = max(i32(0), min(floors - 1, floor));
var paired = x(row, 542) != 0;
var position = f32(x(row, 32)) * top;
var distance = abs(f32(floor) - position) / top;
f[0] = 1;
f[1] = flag(choice == 31);
f[2] = flag(command == 30);
f[3] = flag(command == base);
f[4] = f32(floor) / top;
f[5] = flag(floor == 0);
f[6] = flag(floor == floors - 1);
f[7] = (f32(floor) - position) / top;
f[8] = distance;
f[9] = flag(floor == currentTarget);
f[10] = flag(abs(f32(floor) - position) < 0.01);
f[11] = flag(paired);
f[12] = f32(x(row, 467));
f[13] = f32(x(row, 468));
f[14] = f32(x(row, 469));
f[15] = f32(x(row, 543));
for(var side:i32=0;side<i32(2);side++){
if(side == 1 && ! paired){
continue;
}
var local = i32(32 + 69 * side);
var queue = i32(170 + 30 * side);
var phase = i32(356 + 9 * side);
var mechanics = i32(320 + 18 * side);
var dest = floor;
if(side == 1){
dest = floors - 1 - floor;
}
var offset = 16 + 24 * i32(side);
var cargo = f32(x(row, local + 8 + dest));
var oldest = f32(x(row, local + 39 + dest));
var age = f32(x(row, phase + 6));
var waiting = min(f32(2), 5 * f32(x(row, queue + dest)));
var onboard = flag(cargo > 0);
var pickup = flag(waiting > 0);
f[offset] = onboard;
f[offset + 1] = min(f32(2), 4 * cargo);
f[offset + 2] = oldest;
f[offset + 3] = oldest * age;
f[offset + 4] = pickup;
f[offset + 5] = waiting;
f[offset + 6] = pickup * f32(x(row, 230 + dest));
f[offset + 7] = pickup * age;
f[offset + 8] = f32(x(row, local + 2));
f[offset + 9] = flag(x(row, local + 2) == 0);
f[offset + 10] = age;
f[offset + 11] = distance * onboard;
f[offset + 12] = distance * pickup;
f[offset + 13] = f32(x(row, phase + 1));
f[offset + 14] = f32(x(row, phase + 2));
f[offset + 15] = f32(x(row, phase + 3));
f[offset + 16] = f32(x(row, local + 6));
f[offset + 17] = f32(x(row, local + 7));
f[offset + 18] = f32(x(row, mechanics + 13));
f[offset + 19] = f32(x(row, mechanics + 4));
f[offset + 20] = f32(x(row, mechanics + 5));
f[offset + 21] = f32(x(row, mechanics + 9));
f[offset + 22] = f32(x(row, mechanics + 10));
f[offset + 23] = f32(x(row, mechanics + 11));
}
for(var r:i32=0;r<25;r++){
f[64 + r] = f32(x(row, 1 + r));
}
for(var j:i32=0;j<8;j++){
f[89 + j] = f32(x(row, 438 + j));
}
var vip_origin = i32(f32(x(row, 438)) * 30 + 0.5) - 1;
var vip_dest = i32(f32(x(row, 439)) * 30 + 0.5) - 1;
var blocked = i32(f32(x(row, 440)) * 20 + 0.5) - 1;
var car = i32(f32(x(row, 466)) * 20 + 0.5);
var partner = i32(f32(x(row, 470)) * 20 + 0.5) - 1;
f[97] = flag(floor == vip_origin);
f[98] = flag(paired && floors - 1 - floor == vip_origin);
f[99] = flag(car == blocked);
f[100] = flag(paired && partner == blocked);
f[101] = flag(vip_origin >= 0);
f[102] = flag(vip_dest >= 0);
f[103] = f32(x(row, 466));
f[104] = f32(x(row, 541));
f[105] = f32(x(row, 26));
f[106] = f32(x(row, 27));
f[107] = flag(f[16] > 0 && f[40] > 0);
f[108] = flag(f[16] + f[40] > 0 && f[20] + f[44] > 0);
f[109] = f32(x(row, 34)) * f[21];
f[110] = flag(floor == currentTarget) * f32(x(row, 357));
for(var j:i32=0;j<6;j++){
f[111 + j] = f32(x(row, 535 + j));
}
var nearest = f32(1);
var coverage:f32 = 0;
var vip_coverage:f32 = 0;
for(var other:i32=0;other<i32(20);other++){
if(other == car || other == partner || x(row, 446 + other) == 0){
continue;
}
var other_target = i32(f32(x(row, 261 + 3 * other)) * top + 0.5);
coverage += flag(other_target == floor);
vip_coverage += flag(vip_origin >= 0 && other_target == vip_origin);
if(x(row, 262 + 3 * other) == 0){
nearest = min(nearest, abs(f32(x(row, 260 + 3 * other)) - f32(floor) / top));
}
}
f[117] = coverage / 20;
f[118] = nearest;
f[119] = distance - nearest;
f[120] = vip_coverage / 20;
f[121] = flag(vip_origin == currentTarget);
f[122] = f32(x(row, 357));
f[123] = f32(x(row, 366));
var observed_dest = i32(f32(x(row, 442)) * 30 + 0.5) - 1;
f[124] = flag(observed_dest >= 0 && floor == observed_dest);
f[125] = flag(observed_dest >= 0 && paired && floors - 1 - floor == observed_dest);
f[126] = f32(x(row, 444)) * f[124];
f[127] = f32(x(row, 444)) * f[125];
for(var j:i32=0;j<64;j++){
f[128 + j] = f32(x(row, 374 + j));
}
for(var j:i32=0;j<60;j++){
f[192 + j] = f32(x(row, 260 + j));
}
for(var j:i32=0;j<4;j++){
f[252 + j] = f32(x(row, 28 + j));
}
return f;
}
