import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {MonthPicker} from './MonthPicker';
afterEach(cleanup);
it('changes only the year and retains the month without deriving a day or UTC instant',()=>{
  const onChange=vi.fn();
  const {container}=render(<MonthPicker id="month" value="2028-02" onChange={onChange} />);
  expect(container.querySelector('select,input[type="month"]')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Mes a revisar: año'}));
  fireEvent.click(screen.getByRole('option',{name:'2027'}));
  expect(onChange).toHaveBeenCalledExactlyOnceWith('2027-02');
  expect(container.querySelector('#month')).toHaveValue('2028-02');
});
it('limits years to the existing supported range and disables both selectors',()=>{
  const onChange=vi.fn();
  const view=render(<MonthPicker value="2026-10" onChange={onChange} />);
  fireEvent.click(screen.getByRole('button',{name:'Mes a revisar: año'}));
  expect(screen.getAllByRole('option')).toHaveLength(101);
  expect(screen.getByRole('option',{name:'2000'})).toBeVisible();
  expect(screen.getByRole('option',{name:'2100'})).toBeVisible();
  expect(screen.queryByRole('option',{name:'1999'})).not.toBeInTheDocument();
  view.rerender(<MonthPicker value="2026-10" onChange={onChange} disabled />);
  expect(screen.getByRole('button',{name:'Mes a revisar: mes'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'Mes a revisar: año'})).toBeDisabled();
  expect(onChange).not.toHaveBeenCalled();
});
