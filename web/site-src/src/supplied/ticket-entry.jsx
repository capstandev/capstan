import React from 'react';
import {mountSupplied} from './mount';
import SizedTicket from './SizedTicket';
import '../capstan-supplied.css';
mountSupplied({page:'about',kicker:'YOUR CAPSTAN PASS',heading:'Your next stop: a clearer view.',copy:'A little interactive keepsake. Pull the perforated edge, or focus it and press Enter.',node:<SizedTicket/>});
