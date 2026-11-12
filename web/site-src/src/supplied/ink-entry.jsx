import React from 'react';
import {mountSupplied} from './mount';
import InkButton from '../components/InkButton/InkButton';
import '../capstan-supplied.css';
mountSupplied({page:'use-cases',kicker:'COME EXPLORE',heading:'Curious what you could build?',copy:'Discover the Capstan toolkit and the workflows it supports.',node:<InkButton label="Explore the toolkit" href="developers.html" theme={{background:'#dceffc',ink:'#082b4f',light:'#c7efff',label:'#fff',muted:'#17385f'}}/>});
